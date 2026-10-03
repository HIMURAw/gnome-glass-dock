import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {Glass} from './glass.js';
import {AppIcon, DockIcon, Separator, ShowAppsIcon, TrashIcon} from './icons.js';

// How fast sizes follow their targets: the time constant of an exponential
// approach, in seconds. Short enough to feel direct, long enough to be smooth.
const SCALE_TAU = 0.075;
const PRESENCE_TAU = 0.09;
// Magnification falls off like a bell curve this many icons wide.
const MAGNIFY_SPREAD = 1.3;
const EPSILON = 0.002;
// Drag an icon this far above the dock and let go to take it off.
const REMOVE_DISTANCE = 80;

// Lays the icons out in a row, each at the width the dock gives it, with a
// gap that grows and shrinks with the icon arriving or leaving.
const RowLayout = GObject.registerClass(
class RowLayout extends Clutter.LayoutManager {
    _init(spacing) {
        super._init();
        this._spacing = spacing;
    }

    _gap(child) {
        return this._spacing * (child._delegate?.presence ?? 1);
    }

    vfunc_get_preferred_width(container, _forHeight) {
        let width = 0;
        let first = true;
        for (const child of container) {
            width += child.get_width() + (first ? 0 : this._gap(child));
            first = false;
        }
        return [width, width];
    }

    vfunc_get_preferred_height(container, _forWidth) {
        const height = Math.max(0, ...[...container].map(c => c.get_height()));
        return [height, height];
    }

    vfunc_allocate(container, box) {
        let x = box.x1;
        let first = true;
        for (const child of container) {
            if (!first)
                x += this._gap(child);
            first = false;
            const w = child.get_width();
            child.allocate(new Clutter.ActorBox({x1: x, y1: box.y1, x2: x + w, y2: box.y2}));
            x += w;
        }
    }
});

// Places the row at the bottom center of the dock area, the glass around it,
// and the name label wherever the dock last put it.
const DockLayout = GObject.registerClass(
class DockLayout extends Clutter.LayoutManager {
    _init(dock) {
        super._init();
        this._dock = dock;
    }

    vfunc_get_preferred_width(_container, _forHeight) {
        return [0, 0];
    }

    vfunc_get_preferred_height(_container, _forWidth) {
        return [0, 0];
    }

    vfunc_allocate(_container, box) {
        const d = this._dock;
        const [, rowWidth] = d.row.get_preferred_width(-1);
        const x = box.x1 + Math.round((box.get_width() - rowWidth) / 2);
        const y = box.y2 - d.margin - d.padBottom - d.iconSize;
        d.row.allocate(new Clutter.ActorBox({x1: x, y1: y, x2: x + rowWidth, y2: y + d.iconSize}));
        d.glass.allocate(new Clutter.ActorBox({
            x1: x - d.padX,
            y1: y - d.padTop,
            x2: x + rowWidth + d.padX,
            y2: y + d.iconSize + d.padBottom,
        }));
        const [, lw] = d.label.get_preferred_width(-1);
        const [, lh] = d.label.get_preferred_height(lw);
        const [lx, ly] = d.labelPosition;
        d.label.allocate(new Clutter.ActorBox({x1: lx, y1: ly, x2: lx + lw, y2: ly + lh}));
    }
});

export class Dock {
    constructor({settings, glassMenus, launcher}) {
        this.settings = settings;
        this.glassMenus = glassMenus;
        this.launcher = launcher;
        this.iconSize = settings.get_int('icon-size');
        this.magnification = Math.max(1, settings.get_double('magnification'));
        this.textureSize = Math.ceil(this.iconSize * this.magnification);
        this.padX = Math.round(this.iconSize * 0.2);
        this.padTop = Math.round(this.iconSize * 0.18);
        this.padBottom = Math.round(this.iconSize * 0.28);
        this.dotOffset = Math.round(this.padBottom * 0.3);
        this.spacing = Math.round(this.iconSize * 0.14);
        this.separatorWidth = Math.round(this.iconSize * 0.34);
        this.margin = 8;
        this.labelPosition = [0, 0];

        this._items = [];
        this._keyed = new Map();
        this._hoverX = null;
        this._menuOpen = false;
        this._dragging = null;
        this._ids = [];

        this.actor = new St.Widget({layout_manager: new DockLayout(this)});
        const height = this.iconSize + this.padTop + this.padBottom;
        this.glass = new Glass({
            style_class: 'gdock-glass',
            radius: Math.round(height * 0.34),
            reactive: true,
            track_hover: true,
        });
        this.row = new St.Widget({layout_manager: new RowLayout(this.spacing), reactive: true, track_hover: true});
        this.label = new St.Label({style_class: 'gdock-label', opacity: 0});
        this.actor.add_child(this.glass);
        this.actor.add_child(this.row);
        this.actor.add_child(this.label);

        // Drops onto the dock pin apps, or move pinned ones.
        this.row._delegate = this;
        this.glass._delegate = this;

        this.menuManager = new PopupMenu.PopupMenuManager(this.actor);

        for (const actor of [this.row, this.glass]) {
            this._ids.push([actor, actor.connect('motion-event', (_a, event) => {
                [this._hoverX] = event.get_coords();
                this._kick();
                return Clutter.EVENT_PROPAGATE;
            })]);
            this._ids.push([actor, actor.connect('notify::hover', () => this._onHoverChanged())]);
        }

        this._timeline = new Clutter.Timeline({actor: this.actor, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._tick());
        // At shell shutdown the dock goes before this object is told; stop
        // touching its icons from then on.
        this._gone = false;
        this.actor.connect('destroy', () => {
            this._gone = true;
            this._timeline.stop();
        });

        const appSystem = Shell.AppSystem.get_default();
        const tracker = Shell.WindowTracker.get_default();
        this._ids.push([appSystem, appSystem.connect('installed-changed', () => this.sync())]);
        this._ids.push([appSystem, appSystem.connect('app-state-changed', () => this.sync())]);
        this._ids.push([AppFavorites.getAppFavorites(), AppFavorites.getAppFavorites().connect('changed', () => this.sync())]);
        this._ids.push([tracker, tracker.connect('notify::focus-app', () => this._syncApps())]);
        this._ids.push([global.workspace_manager, global.workspace_manager.connect('active-workspace-changed', () => this._syncApps())]);
        this._ids.push([global.display, global.display.connect('window-demands-attention', (_d, w) => this._attention(w))]);
        this._ids.push([global.display, global.display.connect('window-marked-urgent', (_d, w) => this._attention(w))]);

        this.sync();
        // The first icons appear in place, without the arrival animation.
        for (const item of this._items) {
            item.presence = 1;
            item.apply();
        }
    }

    get hovered() {
        return this.row.hover || this.glass.hover;
    }

    get busy() {
        return this.hovered || this._menuOpen || !!this._dragging;
    }

    // The screen rectangle the resting dock covers (for auto-hide).
    get restingRect() {
        const [x, y] = this.glass.get_transformed_position();
        const [w, h] = this.glass.get_transformed_size();
        return {x, y, width: w, height: h};
    }

    // ---------- Items ----------

    _desired() {
        const s = this.settings;
        const favorites = AppFavorites.getAppFavorites().getFavorites();
        const favoriteIds = new Set(favorites.map(a => a.get_id()));
        // Other running apps keep the order they first appeared in.
        this._runningOrder ??= [];
        const running = Shell.AppSystem.get_default().get_running()
            .filter(a => !favoriteIds.has(a.get_id()))
            .sort((a, b) => this._firstSeen(a) - this._firstSeen(b));

        const keys = [];
        if (s.get_boolean('show-apps-button'))
            keys.push(['show-apps', () => new ShowAppsIcon(this)]);
        for (const app of favorites)
            keys.push([app.get_id(), () => new AppIcon(this, app)]);
        if (s.get_boolean('show-running') && running.length) {
            if (favorites.length)
                keys.push(['separator-running', () => new Separator(this)]);
            for (const app of running)
                keys.push([app.get_id(), () => new AppIcon(this, app)]);
        }
        if (s.get_boolean('show-trash')) {
            keys.push(['separator-trash', () => new Separator(this)]);
            keys.push(['trash', () => new TrashIcon(this)]);
        }
        return keys;
    }

    _firstSeen(app) {
        const id = app.get_id();
        let index = this._runningOrder.indexOf(id);
        if (index < 0) {
            this._runningOrder.push(id);
            index = this._runningOrder.length - 1;
        }
        return index;
    }

    // Brings the row in line with favorites and running apps. New icons grow
    // in, gone ones shrink away where they were.
    sync() {
        const desired = this._desired();
        const wanted = new Set(desired.map(([key]) => key));
        const next = [];
        for (const [key, create] of desired) {
            // An icon still shrinking away grows back instead of being left
            // behind, still connected, next to a new one.
            let item = this._keyed.get(key) ??
                this._items.find(o => o.key === key && !o.removed && o !== this._placeholder);
            if (!item || item.removed) {
                item = create();
                item.key = key;
                this.row.add_child(item.actor);
            }
            this._keyed.set(key, item);
            item.targetPresence = 1;
            next.push(item);
        }
        // Leaving items stay next to the neighbour they had, until they are gone.
        for (let i = 0; i < this._items.length; i++) {
            const item = this._items[i];
            if (wanted.has(item.key) || item.removed || item === this._placeholder)
                continue;
            item.targetPresence = 0;
            this._keyed.delete(item.key);
            const before = this._items.slice(0, i).reverse().find(o => next.includes(o));
            next.splice(before ? next.indexOf(before) + 1 : 0, 0, item);
        }
        if (this._placeholder)
            next.splice(Math.min(this._placeholderIndex, next.length), 0, this._placeholder);
        this._items = next;
        next.forEach((item, i) => this.row.set_child_at_index(item.actor, i));
        this._syncApps();
        this._kick();
    }

    _syncApps() {
        for (const item of this._items) {
            if (item instanceof AppIcon && !item.removed)
                item.sync();
        }
    }

    // A badge or progress changed for this app.
    onLauncherChanged(appId) {
        const item = this._keyed.get(appId);
        if (item instanceof AppIcon)
            item.sync();
    }

    _attention(window) {
        const app = Shell.WindowTracker.get_default().get_window_app(window);
        const item = app && this._keyed.get(app.get_id());
        item?.bounce(2);
    }

    // ---------- Animation ----------

    _kick() {
        if (!this._gone && !this._timeline.is_playing()) {
            this._lastFrame = null;
            this._timeline.start();
        }
    }

    _onHoverChanged() {
        if (!this.hovered)
            this._hoverX = null;
        this._kick();
    }

    _targetScales() {
        const magnify = this.magnification > 1 && this._hoverX !== null &&
            !this._menuOpen && !this._dragging;
        if (!magnify)
            return this._items.map(() => 1);
        // Positions at rest, so magnifying never feeds back into itself.
        const widths = this._items.map(item =>
            (item.isSeparator ? this.separatorWidth : this.iconSize) * item.presence);
        const gaps = this._items.map((item, i) => (i ? this.spacing * item.presence : 0));
        const total = widths.reduce((a, b) => a + b, 0) + gaps.reduce((a, b) => a + b, 0);
        const [ax] = this.actor.get_transformed_position();
        const center = ax + this.actor.width / 2;
        const pointer = this._hoverX - center;
        const sigma = this.iconSize * MAGNIFY_SPREAD;
        let x = -total / 2;
        return this._items.map((item, i) => {
            x += gaps[i];
            const mid = x + widths[i] / 2;
            x += widths[i];
            if (item.isSeparator)
                return 1;
            const d = (pointer - mid) / sigma;
            return 1 + (this.magnification - 1) * Math.exp(-d * d);
        });
    }

    _tick() {
        if (this._gone)
            return;
        const now = this._timeline.get_elapsed_time();
        const dt = this._lastFrame === null ? 1 / 60 : Math.max(0, (now - this._lastFrame) / 1000);
        this._lastFrame = now;
        const animate = St.Settings.get().enable_animations;
        const approach = (value, target, tau) => {
            if (!animate)
                return target;
            const k = 1 - Math.exp(-dt / tau);
            const v = value + (target - value) * k;
            return Math.abs(v - target) < EPSILON ? target : v;
        };

        const targets = this._targetScales();
        let moving = false;
        this._items.forEach((item, i) => {
            const scale = approach(item.scale, targets[i], SCALE_TAU);
            const presence = approach(item.presence, item.targetPresence, PRESENCE_TAU);
            if (scale !== item.scale || presence !== item.presence) {
                item.scale = scale;
                item.presence = presence;
                item.apply();
                moving = true;
            }
        });

        const gone = this._items.filter(i => i.targetPresence === 0 && i.presence === 0 && i !== this._placeholder);
        for (const item of gone) {
            this._items.splice(this._items.indexOf(item), 1);
            item.destroy();
        }

        this._syncLabel();
        if (!moving && !gone.length)
            this._timeline.stop();
    }

    // The app's name floats above the icon under the pointer.
    _syncLabel() {
        const item = this._hoverX !== null && !this._menuOpen && !this._dragging
            ? this._items.find(i => !i.isSeparator && i.actor.hover && i.label) : null;
        if (!item) {
            if (this.label.opacity > 0 && !this._labelFading) {
                this._labelFading = true;
                this.label.ease({opacity: 0, duration: 100, onComplete: () => (this._labelFading = false)});
            }
            this._labelItem = null;
            return;
        }
        if (this._labelItem !== item) {
            this._labelItem = item;
            this.label.text = item.label;
            this._labelFading = false;
            this.label.remove_all_transitions();
            this.label.ease({opacity: 255, duration: 120});
        }
        const [ix, iy] = item.iconBox.get_transformed_position();
        const [iw] = item.iconBox.get_transformed_size();
        const [ax, ay] = this.actor.get_transformed_position();
        const [lw] = this.label.get_preferred_width(-1);
        const [, lh] = this.label.get_preferred_height(lw);
        this.labelPosition = [Math.round(ix - ax + (iw - lw) / 2), Math.round(iy - ay - lh - 10)];
        this.actor.queue_relayout();
    }

    onMenuOpenChanged(open) {
        this._menuOpen = open;
        this._kick();
        this.onBusyChanged?.();
    }

    // ---------- Drag and drop ----------

    onDragBegin(item) {
        this._dragging = item;
        this._dragFavorite = AppFavorites.getAppFavorites().isFavorite(item.id);
        item.targetPresence = 0;
        this._dragMonitor = {dragMotion: e => this._dragMotion(e)};
        DND.addDragMonitor(this._dragMonitor);
        this._kick();
        this.onBusyChanged?.();
    }

    onDragCancelled(item) {
        this._endDrag(item);
    }

    onDragEnd(item, success) {
        if (!success && this._dragFavorite) {
            const [, py] = global.get_pointer();
            const {y} = this.restingRect;
            if (py < y - REMOVE_DISTANCE)
                AppFavorites.getAppFavorites().removeFavorite(item.id);
        }
        this._endDrag(item);
    }

    _endDrag(item) {
        if (this._dragMonitor)
            DND.removeDragMonitor(this._dragMonitor);
        this._dragMonitor = null;
        this._dragging = null;
        if (!item.removed)
            item.targetPresence = 1;
        this._removePlaceholder();
        this._kick();
        this.onBusyChanged?.();
    }

    // Drags from outside (the app grid) also land here: the gap closes when
    // the pointer leaves the dock.
    _dragMotion(event) {
        const target = event.targetActor;
        if (!this.actor.contains(target))
            this._removePlaceholder();
        return DND.DragMotionResult.CONTINUE;
    }

    _favoriteSlot(x) {
        // Only pinned apps take part; the dragged one has already folded away.
        const pinned = this._items.filter(i => i instanceof AppIcon && !i.removed &&
            i !== this._dragging && AppFavorites.getAppFavorites().isFavorite(i.id));
        let slot = 0;
        for (const item of pinned) {
            const [ix] = item.actor.get_transformed_position();
            if (x > ix + item.actor.width / 2)
                slot++;
        }
        return {slot, after: slot ? pinned[slot - 1] : null};
    }

    handleDragOver(source, _actor, _x, _y) {
        if (!source?.app || !global.settings.is_writable('favorite-apps'))
            return DND.DragMotionResult.NO_DROP;
        const [px] = global.get_pointer();
        const {slot, after} = this._favoriteSlot(px);
        this._dropSlot = slot;
        const index = after ? this._items.indexOf(after) + 1
            : this._items.findIndex(i => !(i instanceof ShowAppsIcon) && i !== this._dragging);
        this._showPlaceholder(Math.max(0, index));
        return AppFavorites.getAppFavorites().isFavorite(source.app.get_id())
            ? DND.DragMotionResult.MOVE_DROP : DND.DragMotionResult.COPY_DROP;
    }

    acceptDrop(source, _actor, _x, _y) {
        if (!source?.app || this._dropSlot === undefined)
            return false;
        const favorites = AppFavorites.getAppFavorites();
        const id = source.app.get_id();
        if (favorites.isFavorite(id))
            favorites.moveFavoriteToPos(id, this._dropSlot);
        else
            favorites.addFavoriteAtPos(id, this._dropSlot);
        this._removePlaceholder();
        return true;
    }

    _showPlaceholder(index) {
        if (!this._placeholder) {
            this._placeholder = new DockIcon(this);
            this._placeholder.key = 'placeholder';
            this.row.add_child(this._placeholder.actor);
            this._items.splice(index, 0, this._placeholder);
        } else if (this._items.indexOf(this._placeholder) !== index) {
            this._items.splice(this._items.indexOf(this._placeholder), 1);
            this._items.splice(Math.min(index, this._items.length), 0, this._placeholder);
        }
        this._placeholderIndex = this._items.indexOf(this._placeholder);
        this._placeholder.targetPresence = 1;
        this.row.set_child_at_index(this._placeholder.actor, this._placeholderIndex);
        this._kick();
    }

    // The gap closes smoothly; the frame loop drops it once it is gone.
    _removePlaceholder() {
        const p = this._placeholder;
        if (!p)
            return;
        this._placeholder = null;
        this._dropSlot = undefined;
        p.key = 'placeholder-closing';
        p.targetPresence = 0;
        this._kick();
    }

    destroy() {
        this._timeline.stop();
        this._gone = true;
        if (this._dragMonitor)
            DND.removeDragMonitor(this._dragMonitor);
        for (const [obj, id] of this._ids)
            obj.disconnect(id);
        this._ids = [];
        for (const item of this._items)
            item.destroy();
        this._items = [];
        this._keyed.clear();
        this.actor.destroy();
    }
}
