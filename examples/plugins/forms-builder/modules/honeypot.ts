/**
 * Forms Builder — `pagebuilder.forms.honeypot`
 *
 * Invisible honeypot field. Real users never see or fill it. If the server
 * receives a non-empty value for any field starting with `_hp_`, the
 * submission is silently discarded (204 No Content).
 *
 * The field is hidden via inline style (position:absolute;left:-9999px) which
 * is the only inline style exception allowed — it's a dynamic anti-bot measure,
 * not static styling.
 */
import { control, defineModule, raw } from '@pagebuilder/plugin-sdk'

export default defineModule({
  id: 'pagebuilder.forms.honeypot',
  name: 'Honeypot (Anti-Spam)',
  description: 'Invisible honeypot field for bot detection. Drop once per form.',
  category: 'Forms',
  htmlTag: 'div',
  canHaveChildren: false,
  defaults: {
    name: '_hp_email',
  },
  schema: {
    name: control.text('Field Name', {
      placeholder: '_hp_email',
      description: 'Must begin with "_hp_". The server rejects any submission where this field is non-empty.',
    }),
  },
  render: ({ props }) => ({
    html: raw(
      `<div aria-hidden="true" style="position:absolute;left:-9999px;top:-9999px;overflow:hidden;height:0;">` +
      `<label for="pb-hp-${props.name}">Leave this field empty</label>` +
      `<input id="pb-hp-${props.name}" type="text" name="${props.name}" value="" tabindex="-1" autocomplete="off">` +
      `</div>`,
    ),
  }),
})
