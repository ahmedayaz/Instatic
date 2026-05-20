/**
 * Forms Builder — `pagebuilder.forms.textarea`
 *
 * Multi-line textarea field with accessible label and helper text.
 */
import { control, defineModule, html, raw } from '@pagebuilder/plugin-sdk'

export default defineModule({
  id: 'pagebuilder.forms.textarea',
  name: 'Textarea',
  description: 'Multi-line text area field.',
  category: 'Forms',
  htmlTag: 'div',
  canHaveChildren: false,
  defaults: {
    name: 'message',
    label: 'Message',
    placeholder: '',
    required: false,
    helperText: '',
    rows: 4,
  },
  schema: {
    name: control.text('Field Name', {
      placeholder: 'message',
      description: 'HTML name attribute — must be unique within the form.',
    }),
    label: control.text('Label'),
    placeholder: control.text('Placeholder'),
    required: control.toggle('Required'),
    helperText: control.text('Helper Text'),
    rows: control.number('Rows', { min: 2, max: 20, step: 1 }),
  },
  render: ({ props }) => {
    const requiredAttr = props.required ? ' required' : ''
    const placeholderAttr = props.placeholder ? ` placeholder="${props.placeholder}"` : ''
    const asterisk = props.required
      ? raw('<span class="pb-forms-required" aria-hidden="true">*</span>')
      : raw('')
    const helper = props.helperText
      ? html`<small class="pb-forms-help">${props.helperText}</small>`
      : ''
    return {
      html: html`<div class="pb-forms-field">
  <label class="pb-forms-label" for="pb-${props.name}">${props.label}${asterisk}</label>
  <textarea
    class="pb-forms-control"
    id="pb-${props.name}"
    name="${props.name}"
    rows="${props.rows}"${raw(placeholderAttr)}${raw(requiredAttr)}
  ></textarea>
  ${raw(helper)}
</div>`,
    }
  },
})
