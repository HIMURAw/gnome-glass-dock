import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import Shell from 'gi://Shell';
import St from 'gi://St';

import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {PopupAnimation} from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';

const BOUNCE_TIME = 230;
// A launch bounces until the app shows a window, but not forever.
const MAX_LAUNCH_BOUNCES = 8;
const MAX_DOTS = 3;
const MAX_MENU_WINDOWS = 8;
// The dock's own menus: no arrow, just a small gap above the icon.
const MENU_STYLE = '-arrow-rise: 10px; -arrow-base: 0px; -arrow-border-width: 0px; ' +
    '-arrow-background-color: transparent; -arrow-border-color: transparent;';

// One place in the dock. The dock drives two numbers every frame: scale (the
// magnification, 1 at rest) and presence (0 while arriving or leaving, 1 when
// in place). The icon itself is drawn once at the largest size it can reach
// and only scaled, so magnifying never reloads a texture.
export class DockIcon {
    constructor(dock, {label = '', styleClass = ''} = {}) {
        this.dock = dock;
        this.base = dock.iconSize;
        this.tex = dock.textureSize;
        this.label = label;
        this.scale = 1;
        this.presence = 0;
        this.targetPresence = 1;
        this.removed = false;

        this.actor = new St.Button({
            style_class: `gdock-item ${styleClass}`,
            can_focus: true,
            track_hover: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO | St.ButtonMask.THREE,
            accessible_name: label,
            height: this.base,
            width: 0,
        });
        this.actor._delegate = this;
        this._stage = new St.Widget({height: this.base});
        this.actor.set_child(this._stage);

        // Reactive, so the part of a magnified icon above the dock still
        // counts as the icon (clicks, hover).
        this.iconBox = new St.Widget({
            width: this.tex,
            height: this.tex,
            reactive: true,
            pivot_point: new Graphene.Point({x: 0.5, y: 1}),
        });
        this._stage.add_child(this.iconBox);
    }

    // Sizes and places everything from scale and presence.
    apply() {
        const width = this.base * this.scale * this.presence;
        this.actor.width = width;
        this._stage.width = width;
        const s = (this.base * this.scale * this.presence) / this.tex;
        this.iconBox.set_position(Math.round((width - this.tex) / 2), this.base - this.tex);
        this.iconBox.set_scale(s, s);
        this.actor.opacity = Math.round(255 * Math.min(1, this.presence * 1.4));
        this._placeExtras(width);
    }

    _placeExtras(_width) {}

    // Up and down a few times, like a launching app on macOS.
    bounce(times = 1) {
        this._bouncesLeft = Math.max(this._bouncesLeft ?? 0, times);
        if (this._bouncing || !St.Settings.get().enable_animations)
            return;
        this._bouncing = true;
        const step = () => {
            if (this._bouncesLeft <= 0 || this.removed) {
                this._bouncing = false;
                return;
            }
            this._bouncesLeft--;
            this.iconBox.ease({
                translation_y: -this.base * 0.45,
                duration: BOUNCE_TIME,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => this.iconBox.ease({
                    translation_y: 0,
                    duration: BOUNCE_TIME,
                    mode: Clutter.AnimationMode.EASE_IN_QUAD,
                    onComplete: step,
                }),
            });
        };
        step();
    }

    stopBouncing() {
        this._bouncesLeft = 0;
    }

    destroy() {
        this.removed = true;
        this.iconBox.remove_all_transitions();
        this.actor.destroy();
    }
}

// A running or pinned app: dots for its windows, a badge and progress bar from
// LauncherEntry, clicks, scrolling through its windows, a menu, and dragging.
export class AppIcon extends DockIcon {
    constructor(dock, app) {
        super(dock, {label: app.get_name(), styleClass: 'gdock-app'});
        this.app = app;

        this._icon = new St.Icon({gicon: app.get_icon(), icon_size: this.tex, fallback_icon_name: 'application-x-executable'});
        this.iconBox.add_child(this._icon);

        this._dots = new St.BoxLayout({style_class: 'gdock-dots'});
        this._stage.add_child(this._dots);

        this._badge = new St.Label({
            style_class: 'gdock-badge',
            style: `font-size: ${Math.round(this.tex * 0.2)}px;`,
            visible: false,
        });
        this.iconBox.add_child(this._badge);

        this._progress = new St.Widget({style_class: 'gdock-progress', visible: false});
        this._progressFill = new St.Widget({style_class: 'gdock-progress-fill'});
        this._progress.add_child(this._progressFill);
        this.iconBox.add_child(this._progress);
        const trackWidth = Math.round(this.tex * 0.76);
        const trackHeight = Math.max(4, Math.round(this.tex * 0.08));
        this._progress.set_size(trackWidth, trackHeight);
        this._progress.set_position(Math.round((this.tex - trackWidth) / 2), Math.round(this.tex * 0.86));
        this._progressFill.set_size(0, trackHeight);

        this._ids = [
            [app, app.connect('windows-changed', () => this.sync())],
            [app, app.connect('notify::state', () => this._onStateChanged())],
        ];
        this.actor.connect('clicked', (_b, button) => this._clicked(button));
        this.actor.connect('scroll-event', (_a, event) => this._scrolled(event));

        this._draggable = DND.makeDraggable(this.actor);
        this._draggable.connect('drag-begin', () => this.dock.onDragBegin(this));
        this._draggable.connect('drag-cancelled', () => this.dock.onDragCancelled(this));
        this._draggable.connect('drag-end', (_d, _time, success) => this.dock.onDragEnd(this, success));

        this.sync();
    }

    get id() {
        return this.app.get_id();
    }

    // DND: what follows the pointer, and where it grows out of.
    getDragActor() {
        return this.app.create_icon_texture(this.base);
    }

    getDragActorSource() {
        return this.iconBox;
    }

    _windows() {
        const workspace = global.workspace_manager.get_active_workspace();
        const all = this.app.get_windows().filter(w => !w.skip_taskbar);
        const here = all.filter(w => w.located_on_workspace(workspace));
        return here.length ? here : all;
    }

    sync() {
        const windows = this.app.get_windows().filter(w => !w.skip_taskbar);
        const focused = Shell.WindowTracker.get_default().focus_app === this.app;
        const n = Math.min(MAX_DOTS, windows.length);
        if (this._dots.get_n_children() !== n || this._dotsFocused !== focused) {
            this._dots.destroy_all_children();
            for (let i = 0; i < n; i++)
                this._dots.add_child(new St.Widget({style_class: focused ? 'gdock-dot gdock-dot-focused' : 'gdock-dot'}));
            this._dotsFocused = focused;
        }

        const entry = this.dock.launcher?.get(this.id) ?? {};
        this._badge.visible = entry.count > 0;
        if (this._badge.visible) {
            this._badge.text = entry.count > 99 ? '99+' : String(entry.count);
            const [, w] = this._badge.get_preferred_width(-1);
            this._badge.set_position(Math.round(this.tex - w + this.tex * 0.04), -Math.round(this.tex * 0.04));
        }
        this._progress.visible = entry.progress !== null && entry.progress !== undefined;
        if (this._progress.visible)
            this._progressFill.width = Math.round(this._progress.width * entry.progress);
        if (entry.urgent && !this._wasUrgent)
            this.bounce(2);
        this._wasUrgent = !!entry.urgent;
        this.apply();
    }

    _placeExtras(width) {
        const [, dotsWidth] = this._dots.get_preferred_width(-1);
        this._dots.set_position(Math.round((width - dotsWidth) / 2), this.base + this.dock.dotOffset);
        this._dots.opacity = Math.round(255 * this.presence);
    }

    _onStateChanged() {
        if (this.app.state === Shell.AppState.STARTING)
            this.bounce(MAX_LAUNCH_BOUNCES);
        else
            this.stopBouncing();
        this.sync();
    }

    _launchFeedback() {
        // Some apps never pass through STARTING; bounce a little anyway.
        this.bounce(this.app.state === Shell.AppState.RUNNING ? 1 : 2);
    }

    _clicked(button) {
        if (button === Clutter.BUTTON_SECONDARY) {
            this._openMenu();
            return;
        }
        if (Main.overview.visible)
            Main.overview.hide();
        if (button === Clutter.BUTTON_MIDDLE) {
            if (this.app.can_open_new_window())
                this.app.open_new_window(-1);
            else
                this.app.activate();
            this._launchFeedback();
            return;
        }

        const windows = this._windows();
        if (!windows.length) {
            this.app.activate();
            this._launchFeedback();
            return;
        }
        const focus = global.display.focus_window;
        if (!windows.includes(focus)) {
            Main.activateWindow(windows[0]);
            return;
        }
        if (windows.length > 1) {
            // Round the app's windows, oldest first, so every click shows another.
            const next = windows[windows.length - 1];
            Main.activateWindow(next);
        } else if (this.dock.settings.get_boolean('click-minimizes')) {
            windows[0].minimize();
        }
    }

    _scrolled(event) {
        const direction = event.get_scroll_direction();
        if (direction !== Clutter.ScrollDirection.UP && direction !== Clutter.ScrollDirection.DOWN)
            return Clutter.EVENT_PROPAGATE;
        const now = GLib.get_monotonic_time();
        // A touchpad sends a stream of scroll events; take one step per gesture.
        if (now - (this._lastScroll ?? 0) < 250000)
            return Clutter.EVENT_STOP;
        this._lastScroll = now;
        const windows = this._windows();
        if (windows.length) {
            const target = direction === Clutter.ScrollDirection.DOWN ? windows[windows.length - 1] : windows[1] ?? windows[0];
            Main.activateWindow(target);
        }
        return Clutter.EVENT_STOP;
    }

    _openMenu() {
        if (!this._menu) {
            this._menu = new PopupMenu.PopupMenu(this.actor, 0.5, St.Side.BOTTOM);
            this._menu.actor.style = MENU_STYLE;
            this._menu.actor.add_style_class_name('gdock-menu');
            Main.uiGroup.add_child(this._menu.actor);
            this._menu.actor.hide();
            this.dock.menuManager.addMenu(this._menu);
            this.dock.glassMenus?.add(this._menu);
            this._menu.connect('open-state-changed', (_m, open) => this.dock.onMenuOpenChanged(open));
        }
        this._fillMenu();
        this._menu.open(PopupAnimation.FULL);
    }

    _fillMenu() {
        const menu = this._menu;
        menu.removeAll();
        const title = new PopupMenu.PopupMenuItem(this.app.get_name(), {reactive: false});
        title.add_style_class_name('gdock-menu-title');
        menu.addMenuItem(title);

        const windows = this.app.get_windows().filter(w => !w.skip_taskbar);
        if (windows.length) {
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            for (const window of windows.slice(0, MAX_MENU_WINDOWS)) {
                const item = menu.addAction(window.get_title() || this.app.get_name(),
                    () => Main.activateWindow(window));
                if (window === global.display.focus_window)
                    item.setOrnament(PopupMenu.Ornament.DOT);
            }
        }

        const info = this.app.get_app_info();
        const actions = info?.list_actions?.() ?? [];
        if (actions.length || this.app.can_open_new_window())
            menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        if (this.app.can_open_new_window() && !actions.includes('new-window')) {
            menu.addAction(_('New Window'), () => {
                this.app.open_new_window(-1);
                this._launchFeedback();
            });
        }
        for (const action of actions) {
            menu.addAction(info.get_action_name(action), () => {
                this.app.launch_action(action, global.get_current_time(), -1);
                this._launchFeedback();
            });
        }

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const favorites = AppFavorites.getAppFavorites();
        if (info && global.settings.is_writable('favorite-apps')) {
            if (favorites.isFavorite(this.id))
                menu.addAction(_('Remove from Dock'), () => favorites.removeFavorite(this.id));
            else
                menu.addAction(_('Keep in Dock'), () => favorites.addFavorite(this.id));
        }
        if (this.app.state !== Shell.AppState.STOPPED)
            menu.addAction(windows.length > 1 ? _('Quit All Windows') : _('Quit'), () => this.app.request_quit());
    }

    destroy() {
        for (const [obj, id] of this._ids)
            obj.disconnect(id);
        this._ids = [];
        this._menu?.destroy();
        this._menu = null;
        super.destroy();
    }
}

// Opens the app grid, like Launchpad.
export class ShowAppsIcon extends DockIcon {
    constructor(dock) {
        super(dock, {label: _('Show Apps'), styleClass: 'gdock-show-apps'});
        const tile = new St.Widget({
            style_class: 'gdock-show-apps-tile',
            width: this.tex,
            height: this.tex,
            style: `border-radius: ${Math.round(this.tex * 0.24)}px;`,
        });
        const glyph = new St.Icon({icon_name: 'view-app-grid-symbolic', icon_size: Math.round(this.tex * 0.46)});
        const offset = Math.round(this.tex * 0.27);
        glyph.set_position(offset, offset);
        tile.add_child(glyph);
        this.iconBox.add_child(tile);
        this.actor.connect('clicked', () => {
            if (Main.overview.visible && Main.overview.dash?.showAppsButton?.checked)
                Main.overview.hide();
            else
                Main.overview.showApps();
        });
    }
}

// The trash, full or empty; click to open it in Files.
export class TrashIcon extends DockIcon {
    constructor(dock) {
        super(dock, {label: _('Trash'), styleClass: 'gdock-trash'});
        this._icon = new St.Icon({icon_name: 'user-trash', icon_size: this.tex});
        this.iconBox.add_child(this._icon);
        this._file = Gio.File.new_for_uri('trash:///');
        this._cancellable = new Gio.Cancellable();
        try {
            this._monitor = this._file.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._monitorId = this._monitor.connect('changed', () => this._queueSync());
        } catch (e) {
            console.warn('Glass Dock: cannot watch the trash', e.message);
        }
        this.actor.connect('clicked', () => {
            if (Main.overview.visible)
                Main.overview.hide();
            Gio.AppInfo.launch_default_for_uri_async('trash:///',
                global.create_app_launch_context(0, -1), null, null);
        });
        this._sync();
    }

    _queueSync() {
        if (this._idle)
            return;
        this._idle = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 300, () => {
            this._idle = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _sync() {
        this._file.query_info_async('trash::item-count', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_LOW, this._cancellable, (file, result) => {
                try {
                    const count = file.query_info_finish(result).get_attribute_uint32('trash::item-count');
                    this._icon.icon_name = count > 0 ? 'user-trash-full' : 'user-trash';
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn('Glass Dock: cannot read the trash', e.message);
                }
            });
    }

    destroy() {
        this._cancellable.cancel();
        if (this._idle)
            GLib.source_remove(this._idle);
        this._idle = 0;
        if (this._monitor) {
            this._monitor.disconnect(this._monitorId);
            this._monitor.cancel();
        }
        super.destroy();
    }
}

// A thin line between pinned apps, other running apps and the trash.
export class Separator {
    constructor(dock) {
        this.dock = dock;
        this.base = dock.iconSize;
        this.scale = 1;
        this.presence = 0;
        this.targetPresence = 1;
        this.removed = false;
        this.isSeparator = true;
        this.actor = new St.Widget({height: this.base, width: 0});
        this._line = new St.Widget({style_class: 'gdock-separator'});
        this.actor.add_child(this._line);
    }

    apply() {
        const width = Math.round(this.dock.separatorWidth * this.presence);
        this.actor.width = width;
        const height = Math.round(this.base * 0.62);
        this._line.set_size(1, height);
        this._line.set_position(Math.round(width / 2), Math.round((this.base - height) / 2));
        this.actor.opacity = Math.round(255 * this.presence);
    }

    bounce() {}

    destroy() {
        this.removed = true;
        this.actor.destroy();
    }
}
