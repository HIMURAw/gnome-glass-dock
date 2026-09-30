import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {getPointerWatcher} from 'resource:///org/gnome/shell/ui/pointerWatcher.js';

import {Dock} from './dock.js';
import {setBlurEnabled} from './glass.js';
import {LauncherEntries} from './launcher.js';
import {GlassMenus} from './menus.js';
import {spring, stopAllSprings, stopSpring} from './spring.js';

// Room above the resting dock for the name label (px).
const LABEL_ROOM = 44;
// Auto-hide: how long the pointer rests on the bottom edge before the dock
// comes back (ms), and how far around it the pointer may go before it hides.
const REVEAL_DELAY = 150;
const REVEAL_SLACK = 40;
// Desktop Icons NG (and forks) let other extensions reserve room on the desktop
// through an object tagged with this id, the same way Dash to Dock does.
const DESKTOP_ICONS_ID = '130cbc66-235c-4bd6-8571-98d2d8bba5e2';

export default class GlassDockExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        // Any change rebuilds the dock: disable() undoes everything, so building
        // again with the new settings is the simplest safe way.
        this._settingsId = this._settings.connect('changed', () => this._queueRebuild());
        this._start();
    }

    disable() {
        if (this._rebuildId)
            GLib.source_remove(this._rebuildId);
        this._rebuildId = 0;
        this._settings.disconnect(this._settingsId);
        this._teardown();
        this._settings = null;
    }

    _queueRebuild() {
        if (this._rebuildId)
            return;
        this._rebuildId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 250, () => {
            this._rebuildId = 0;
            this._teardown();
            this._start();
            return GLib.SOURCE_REMOVE;
        });
    }

    _start() {
        try {
            this._build();
        } catch (e) {
            console.error('Glass Dock: could not start', e);
            this._teardown();
        }
    }

    _safely(what, fn) {
        try {
            fn();
        } catch (e) {
            console.error(`Glass Dock: ${what} failed, carrying on without it`, e);
        }
    }

    _connect(obj, signal, handler) {
        this._signals.push([obj, obj.connect(signal, handler)]);
    }

    _timeout(ms, callback) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            const result = callback();
            if (result !== GLib.SOURCE_CONTINUE)
                this._timeouts.delete(id);
            return result;
        });
        this._timeouts.add(id);
        return id;
    }

    _clearTimeout(id) {
        if (id && this._timeouts.delete(id))
            GLib.source_remove(id);
        return 0;
    }

    _build() {
        this._signals = [];
        this._timeouts = new Set();
        this._hidden = false;
        this._autoHide = false;
        setBlurEnabled(this._settings.get_boolean('blur'));

        this._glassMenus = new GlassMenus();
        this._safely('badges', () => {
            this._launcher = new LauncherEntries(id => this._dock?.onLauncherChanged(id));
        });
        this._dock = new Dock({
            settings: this._settings,
            glassMenus: this._glassMenus,
            launcher: this._settings.get_boolean('show-badges') ? this._launcher : null,
        });
        this._dock.onBusyChanged = () => this._maybeHide();

        this._container = this._dock.actor;
        Main.layoutManager.addChrome(this._container, {affectsStruts: false, trackFullscreen: false});
        // A separate strip reserves the dock's height at the bottom, so windows
        // do not go under it; the dock area itself is taller (magnified icons).
        const mode = this._settings.get_string('auto-hide');
        this._strut = new St.Widget();
        if (mode !== 'smart')
            Main.layoutManager.addChrome(this._strut, {affectsStruts: true, trackFullscreen: true});
        this._syncGeometry();
        this._connect(Main.layoutManager, 'monitors-changed', () => this._queueRebuild());
        this._connect(this._container, 'notify::translation-y', () => this._dock.glass.syncBackdrop());

        this._safely('overview', () => this._setupOverview());
        this._safely('auto-hide', () => this._setupAutoHide());
        this._safely('desktop icons', () => this._setupDesktopIcons());
    }

    _teardown() {
        stopAllSprings();
        for (const id of this._timeouts ?? [])
            GLib.source_remove(id);
        this._timeouts = new Set();
        this._revealTimeout = this._overlapIdle = 0;

        this._safely('releasing desktop icons', () => this._releaseDesktopIcons());
        this._safely('releasing auto-hide', () => this._releaseAutoHide());
        for (const [obj, id] of this._signals ?? [])
            obj.disconnect(id);
        this._signals = [];

        this._glassMenus?.destroy();
        this._glassMenus = null;
        if (this._container) {
            Main.layoutManager.removeChrome(this._container);
            this._dock.destroy();
        }
        this._dock = this._container = null;
        if (this._strut) {
            if (this._strut.get_parent())
                Main.layoutManager.removeChrome(this._strut);
            this._strut.destroy();
        }
        this._strut = null;
        this._launcher?.destroy();
        this._launcher = null;
    }

    // ---------- Geometry ----------

    _monitorIndex() {
        const index = this._settings.get_int('monitor');
        return Main.layoutManager.monitors[index] ? index : Main.layoutManager.primaryIndex;
    }

    _monitor() {
        return Main.layoutManager.monitors[this._monitorIndex()] ?? Main.layoutManager.primaryMonitor;
    }

    // Height of the resting dock from the bottom edge of the screen.
    get _dockHeight() {
        const d = this._dock;
        return d.margin + d.padBottom + d.iconSize + d.padTop;
    }

    _syncGeometry() {
        const monitor = this._monitor();
        const d = this._dock;
        const height = Math.ceil(this._dockHeight + d.iconSize * (d.magnification - 1) +
            d.iconSize * 0.45 + LABEL_ROOM);
        this._container.set_position(monitor.x, monitor.y + monitor.height - height);
        this._container.set_size(monitor.width, height);
        this._strut.set_position(monitor.x, monitor.y + monitor.height - this._dockHeight);
        this._strut.set_size(monitor.width, this._dockHeight);
    }

    // Where the resting, shown dock is on screen, whatever it is doing now.
    _restingRect() {
        const box = this._dock.glass.get_allocation_box();
        const [cx, cy] = [this._container.x, this._container.y];
        return {x: cx + box.x1, y: cy + box.y1, width: box.get_width(), height: box.get_height()};
    }

    // ---------- Overview ----------

    // GNOME's overview has its own dash along the bottom; ours steps aside.
    _setupOverview() {
        this._connect(Main.overview, 'showing', () => this._setOverview(true));
        this._connect(Main.overview, 'hiding', () => this._setOverview(false));
        if (Main.overview.visible)
            this._setOverview(true);
    }

    _setOverview(shown) {
        this._inOverview = shown;
        this._container.remove_transition('opacity');
        if (shown) {
            this._container.ease({
                opacity: 0,
                duration: 200,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    if (this._inOverview)
                        this._container.hide();
                },
            });
        } else {
            if (!this._hidden)
                this._container.show();
            this._container.ease({opacity: 255, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
    }

    // ---------- Auto-hide ----------

    _setupAutoHide() {
        this._windowIds = new Map();
        for (const actor of global.get_window_actors())
            this._watchWindow(actor.meta_window);
        const queue = () => this._queueOverlapCheck();
        this._connect(global.display, 'window-created', (_d, window) => {
            this._watchWindow(window);
            queue();
        });
        this._connect(global.display, 'restacked', queue);
        this._connect(global.display, 'in-fullscreen-changed', queue);
        this._connect(global.workspace_manager, 'active-workspace-changed', queue);
        this._connect(Main.overview, 'hidden', queue);
        this._checkOverlap();
    }

    _releaseAutoHide() {
        for (const [window, ids] of this._windowIds ?? [])
            ids.forEach(id => window.disconnect(id));
        this._windowIds?.clear();
        this._pointerWatch?.remove();
        this._pointerWatch = null;
    }

    _watchWindow(window) {
        if (!window || this._windowIds.has(window))
            return;
        const queue = () => this._queueOverlapCheck();
        const ids = ['position-changed', 'size-changed', 'notify::minimized', 'workspace-changed']
            .map(signal => window.connect(signal, queue));
        ids.push(window.connect('unmanaged', () => {
            this._windowIds.get(window)?.forEach(id => window.disconnect(id));
            this._windowIds.delete(window);
            queue();
        }));
        this._windowIds.set(window, ids);
    }

    // Window moves come in bursts while dragging; check once per burst.
    _queueOverlapCheck() {
        if (this._overlapIdle)
            return;
        this._overlapIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._timeouts.delete(this._overlapIdle);
            this._overlapIdle = 0;
            this._checkOverlap();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.add(this._overlapIdle);
    }

    _checkOverlap() {
        const monitor = this._monitor();
        if (!monitor || !this._dock)
            return;
        const mode = this._settings.get_string('auto-hide');
        if (mode === 'never') {
            this._setAutoHide(false);
            return;
        }
        const fullscreen = !!monitor.inFullscreen;
        let covered = false;
        if (mode === 'smart' && !Main.overview.visible && !fullscreen) {
            const rect = this._restingRect();
            const workspace = global.workspace_manager.get_active_workspace();
            const types = [Meta.WindowType.NORMAL, Meta.WindowType.DIALOG,
                Meta.WindowType.MODAL_DIALOG, Meta.WindowType.UTILITY];
            covered = global.get_window_actors().some(actor => {
                const w = actor.meta_window;
                if (!w || w.minimized || !types.includes(w.get_window_type()) ||
                    w.is_skip_taskbar() || !w.located_on_workspace(workspace) ||
                    !w.showing_on_its_workspace())
                    return false;
                const f = w.get_frame_rect();
                return f.x < rect.x + rect.width && f.x + f.width > rect.x &&
                    f.y < rect.y + rect.height && f.y + f.height > rect.y;
            });
        }
        this._setAutoHide(fullscreen || covered, fullscreen);
    }

    _setAutoHide(on, fullscreen = false) {
        const wasFullscreen = this._fullscreen;
        this._fullscreen = fullscreen;
        if (on && !this._pointerWatch)
            this._pointerWatch = getPointerWatcher().addWatch(100, (x, y) => this._onPointerMove(x, y));
        else if (!on && this._pointerWatch) {
            this._pointerWatch.remove();
            this._pointerWatch = null;
        }
        const changed = this._autoHide !== on;
        this._autoHide = on;
        if (!on) {
            this._revealTimeout = this._clearTimeout(this._revealTimeout);
            this._setHidden(false);
        } else if (fullscreen && !wasFullscreen) {
            this._setHidden(true);
        } else if (changed) {
            this._maybeHide();
        }
    }

    _pointerNear(x, y) {
        const r = this._restingRect();
        const d = this._dock;
        const top = r.y - d.iconSize * (d.magnification - 1) - REVEAL_SLACK;
        return x >= r.x - REVEAL_SLACK && x <= r.x + r.width + REVEAL_SLACK && y >= top;
    }

    // Hide unless the dock is in use: hovered, a menu open, a drag going on,
    // or the pointer close by.
    _maybeHide() {
        if (!this._autoHide || this._hidden || !this._dock || this._dock.busy)
            return;
        const [x, y] = global.get_pointer();
        if (!this._pointerNear(x, y))
            this._setHidden(true);
    }

    _onPointerMove(x, y) {
        const monitor = this._monitor();
        if (!monitor || x < monitor.x || x >= monitor.x + monitor.width)
            return;
        if (!this._hidden) {
            this._maybeHide();
            return;
        }
        // Only a rest on the bottom edge, below the dock, brings it back.
        const r = this._restingRect();
        const atEdge = y >= monitor.y + monitor.height - 2 &&
            x >= r.x - REVEAL_SLACK && x <= r.x + r.width + REVEAL_SLACK;
        if (!atEdge) {
            this._revealTimeout = this._clearTimeout(this._revealTimeout);
            return;
        }
        if (this._revealTimeout)
            return;
        this._revealTimeout = this._timeout(REVEAL_DELAY, () => {
            this._revealTimeout = 0;
            const [, py] = global.get_pointer();
            if (this._hidden && py >= monitor.y + monitor.height - 2)
                this._setHidden(false);
            return GLib.SOURCE_REMOVE;
        });
    }

    _setHidden(hidden) {
        if (this._hidden === hidden)
            return;
        this._hidden = hidden;
        // A showing spring still running would pull the dock back up.
        stopSpring(this._container);
        const offset = this._dockHeight + 6;
        if (hidden) {
            this._container.ease({
                translation_y: offset,
                duration: 240,
                mode: Clutter.AnimationMode.EASE_IN_CUBIC,
                // Out of sight it is not drawn at all.
                onComplete: () => {
                    if (this._hidden)
                        this._container.hide();
                },
            });
        } else {
            if (!this._inOverview)
                this._container.show();
            spring(this._container, {translation_y: 0}, {response: 0.42, damping: 0.74});
        }
    }

    // ---------- Desktop icons ----------

    // Desktop icons should not hide behind the dock.
    _setupDesktopIcons() {
        this._desktopAreas = new Set();
        this._syncDesktopIcons();
        this._connect(Main.extensionManager, 'extension-state-changed', () => this._syncDesktopIcons());
    }

    _syncDesktopIcons() {
        for (const uuid of Main.extensionManager.getUuids()) {
            const area = Main.extensionManager.lookup(uuid)?.stateObj?.DesktopIconsUsableArea;
            if (area?._extensionUUID !== DESKTOP_ICONS_ID || this._desktopAreas.has(area))
                continue;
            area.setMarginsForExtension(this.uuid, {
                [this._monitorIndex()]: {top: 0, bottom: this._dockHeight, left: 0, right: 0},
            });
            this._desktopAreas.add(area);
        }
    }

    _releaseDesktopIcons() {
        for (const area of this._desktopAreas ?? [])
            area.setMarginsForExtension(this.uuid, null);
        this._desktopAreas = null;
    }
}
