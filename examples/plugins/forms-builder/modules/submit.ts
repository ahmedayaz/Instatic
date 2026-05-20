/**
 * Forms Builder — `pagebuilder.forms.submit`
 *
 * Submit button for a form.
 */
import { control, defineModule, html } from '@pagebuilder/plugin-sdk'

export default defineModule({
  id: 'pagebuilder.forms.submit',
  name: 'Submit Button',
  description: 'Submit button for a form.',
  category: 'Forms',
  htmlTag: 'div',
  canHaveChildren: false,
  defaults: {
    label: 'Submit',
  },
  schema: {
    label: control.text('Button Label', { placeholder: 'Submit' }),
  },
  render: ({ props }) => ({
    html: html`<div class="pb-forms-submit-wrap">
  <button class="pb-forms-submit" type="submit">${props.label}</button>
</div>`,
    css: `
.pb-forms-submit-wrap{display:flex;}
.pb-forms-submit{display:inline-flex;align-items:center;justify-content:center;padding:10px 24px;background:#111;color:#fff;border:none;border-radius:4px;font-size:0.9375rem;font-family:inherit;font-weight:500;cursor:pointer;transition:opacity 0.15s;}
.pb-forms-submit:hover{opacity:0.85;}
.pb-forms-submit:disabled{opacity:0.5;cursor:not-allowed;}
`,
  }),
})
