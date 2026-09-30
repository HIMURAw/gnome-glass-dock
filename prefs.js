import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const AUTO_HIDE = ['never', 'fullscreen', 'smart'];

// Other docks: two at once get in each other's way.
const CONFLICTS = {
    'dash2dock-lite@icedman.github.com': 'Dash2Dock Animated',
    'dash-to-dock@micxgx.gmail.com': 'Dash to Dock',
    'ubuntu-dock@ubuntu.com': 'Ubuntu Dock',
    'dash-to-panel@jderose9.github.com': 'Dash to Panel',
    'blur-my-shell@aunetx': null,
};

export default class GlassDockPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(560, 720);

        const page = new Adw.PreferencesPage({icon_name: 'preferences-system-symbolic'});
        window.add(page);

        const switchRow = (key, title, subtitle = '') => {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            return row;
        };

        // Size and motion
        const look = new Adw.PreferencesGroup({title: _('Appearance')});
        page.add(look);

        const size = new Adw.SpinRow({
            title: _('Icon size'),
            adjustment: new Gtk.Adjustment({lower: 32, upper: 80, step_increment: 4, page_increment: 8}),
        });
        settings.bind('icon-size', size, 'value', Gio.SettingsBindFlags.DEFAULT);
        look.add(size);

        const magnify = new Adw.ActionRow({
            title: _('Magnification'),
            subtitle: _('How large icons grow under the pointer'),
        });
        const scale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: new Gtk.Adjustment({lower: 1, upper: 2.2, step_increment: 0.1}),
            digits: 1,
            draw_value: false,
            hexpand: true,
            width_request: 200,
            valign: Gtk.Align.CENTER,
        });
        scale.add_mark(1, Gtk.PositionType.BOTTOM, _('Off'));
        scale.add_mark(1.6, Gtk.PositionType.BOTTOM, null);
        scale.add_mark(2.2, Gtk.PositionType.BOTTOM, _('Large'));
        settings.bind('magnification', scale.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
        magnify.add_suffix(scale);
        look.add(magnify);

        look.add(switchRow('blur', _('Frosted glass'),
            _('Turn off for a plain dark dock on slower graphics')));

        const monitors = Gdk.Display.get_default()?.get_monitors();
        const count = monitors?.get_n_items() ?? 1;
        if (count > 1) {
            const names = [_('Primary monitor')];
            for (let i = 0; i < count; i++) {
                const monitor = monitors.get_item(i);
                names.push(`${_('Monitor')} ${i + 1}${monitor.model ? ` (${monitor.model})` : ''}`);
            }
            const monitorRow = new Adw.ComboRow({title: _('Monitor'), model: Gtk.StringList.new(names)});
            monitorRow.selected = settings.get_int('monitor') + 1;
            monitorRow.connect('notify::selected', () =>
                settings.set_int('monitor', monitorRow.selected - 1));
            look.add(monitorRow);
        }

        // Behaviour
        const behaviour = new Adw.PreferencesGroup({title: _('Behaviour')});
        page.add(behaviour);
        const autoHide = new Adw.ComboRow({
            title: _('Slide out of the way'),
            subtitle: _('Rest the pointer on the bottom edge to bring it back'),
            model: Gtk.StringList.new([
                _('Never'),
                _('In fullscreen'),
                _('When a window reaches under it'),
            ]),
        });
        autoHide.selected = Math.max(0, AUTO_HIDE.indexOf(settings.get_string('auto-hide')));
        autoHide.connect('notify::selected', () =>
            settings.set_string('auto-hide', AUTO_HIDE[autoHide.selected]));
        behaviour.add(autoHide);
        behaviour.add(switchRow('click-minimizes', _('Click the active app to minimize it')));

        // Contents
        const contents = new Adw.PreferencesGroup({title: _('Dock'), description: _('What the dock shows')});
        page.add(contents);
        contents.add(switchRow('show-apps-button', _('Show Apps button')));
        contents.add(switchRow('show-running', _('Open apps that are not pinned')));
        contents.add(switchRow('show-trash', _('Trash')));
        contents.add(switchRow('show-badges', _('Badges and progress'),
            _('Unread counts and download progress that apps report')));

        this._addCompatibility(page);
        this._addAbout(page);
    }

    _addCompatibility(page) {
        const enabled = new Gio.Settings({schema_id: 'org.gnome.shell'}).get_strv('enabled-extensions');
        const found = Object.keys(CONFLICTS).filter(uuid => enabled.includes(uuid));
        if (!found.length)
            return;
        const group = new Adw.PreferencesGroup({title: _('Compatibility')});
        page.add(group);
        for (const uuid of found) {
            const name = CONFLICTS[uuid];
            group.add(new Adw.ActionRow({
                title: name ?? 'Blur my Shell',
                subtitle: name
                    ? _('Another dock is on. Turn it off so the two do not overlap.')
                    : _('Turn off its dash blur; this dock has its own glass.'),
                subtitle_lines: 3,
                icon_name: 'dialog-warning-symbolic',
            }));
        }
    }

    _addAbout(page) {
        const group = new Adw.PreferencesGroup({title: _('About')});
        page.add(group);
        const url = this.metadata.url;
        const row = new Adw.ActionRow({
            title: _('Report a problem or suggest an idea'),
            subtitle: url,
            activatable: true,
        });
        row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
        row.connect('activated', () =>
            Gtk.UriLauncher.new(`${url}/issues`).launch(row.get_root(), null, null));
        group.add(row);
    }
}
