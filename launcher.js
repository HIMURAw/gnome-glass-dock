import Gio from 'gi://Gio';

// Badges and progress bars that apps publish over D-Bus with the Unity
// LauncherEntry API (Telegram, Discord, Thunderbird, file downloads in GTK
// apps...). Each app sends only what changed, so the latest values are kept
// per app.
export class LauncherEntries {
    constructor(onChanged) {
        this._onChanged = onChanged;
        this._entries = new Map();
        this._senders = new Map();
        this._bus = Gio.DBus.session;
        this._updateId = this._bus.signal_subscribe(null, 'com.canonical.Unity.LauncherEntry',
            'Update', null, null, Gio.DBusSignalFlags.NONE,
            (_conn, sender, _path, _iface, _signal, params) => this._update(sender, params));
        // When an app quits without clearing its badge, the badge goes with it.
        this._ownerId = this._bus.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus',
            'NameOwnerChanged', '/org/freedesktop/DBus', null, Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, _signal, params) => {
                const [name, , newOwner] = params.deep_unpack();
                if (!newOwner && this._senders.has(name))
                    this._forgetSender(name);
            });
    }

    _update(sender, params) {
        const [uri, props] = params.deep_unpack();
        const appId = uri.replace(/^application:\/\//, '');
        if (!appId)
            return;
        const entry = this._entries.get(appId) ?? {};
        for (const [key, value] of Object.entries(props))
            entry[key] = value.deep_unpack();
        this._entries.set(appId, entry);
        if (!this._senders.has(sender))
            this._senders.set(sender, new Set());
        this._senders.get(sender).add(appId);
        this._onChanged(appId);
    }

    _forgetSender(sender) {
        for (const appId of this._senders.get(sender)) {
            this._entries.delete(appId);
            this._onChanged(appId);
        }
        this._senders.delete(sender);
    }

    // {count, progress, urgent} with only what the app currently shows.
    get(appId) {
        const e = this._entries.get(appId);
        if (!e)
            return {};
        return {
            count: e['count-visible'] ? Number(e.count ?? 0) : 0,
            progress: e['progress-visible'] ? Math.max(0, Math.min(1, e.progress ?? 0)) : null,
            urgent: !!e.urgent,
        };
    }

    destroy() {
        this._bus.signal_unsubscribe(this._updateId);
        this._bus.signal_unsubscribe(this._ownerId);
        this._entries.clear();
        this._senders.clear();
    }
}
