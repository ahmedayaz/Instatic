/**
 * pagebuilder.newsletter.preferences-link
 *
 * Renders an anchor tag with the `{{preferences_url}}` placeholder for use
 * inside broadcast HTML bodies. The email-send logic substitutes the
 * placeholder with the subscriber's actual preferences URL before delivery.
 *
 * Do NOT place this module on regular web pages — the placeholder is only
 * meaningful inside email bodies rendered by the newsletter plugin.
 *
 * Props:
 *   label — the link text shown to the recipient
 */
import { control, defineModule, html } from '@core/plugin-sdk'

const PLUGIN_ID = 'pagebuilder.newsletter'

export default defineModule({
  id: `${PLUGIN_ID}.preferences-link`,
  name: 'Preferences Link',
  description:
    'Renders a {{preferences_url}} placeholder anchor for use inside broadcast email bodies. Substituted with the subscriber\'s manage-preferences URL at send time.',
  category: 'Newsletter',
  htmlTag: 'span',
  version: '0.1.0',
  defaults: {
    label: 'Manage email preferences',
  },
  schema: {
    label: control.text('Link label'),
  },
  render: ({ props }) => {
    return {
      html: html`
        <a class="nl-pref-link" href="{{preferences_url}}">${props.label}</a>
      `,
      css: `
        .nl-pref-link { color: inherit; text-decoration: underline; }
        .nl-pref-link:hover { opacity: 0.75; }
      `,
    }
  },
})
