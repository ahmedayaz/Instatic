/**
 * Forms Builder — `pagebuilder.forms.input`
 *
 * Single-line text/email/url/tel/number input with accessible label,
 * helper text, and required-asterisk.
 */
import { control, defineModule, html, raw } from '@pagebuilder/plugin-sdk'

type InputType = 'text' | 'email' | 'url' | 'tel' | 'number'

export default defineModule({
  id: 'pagebuilder.forms.input',
  name: 'Text Input',
  description: 'Single-line input field (text, email, URL, tel, number).',
  category: 'Forms',
  htmlTag: 'div',
  canHaveChildren: false,
  defaults: {
    name: 'field',
    label: 'Label',
    placeholder: '',
    required: false,
    helperText: '',
    inputType: 'text' as InputType,
  },
  schema: {
    name: control.text('Field Name', {
      placeholder: 'field_name',
      description: 'HTML name attribute — must be unique within the form.',
    }),
    label: control.text('Label'),
    placeholder: control.text('Placeholder'),
    required: control.toggle('Required'),
    helperText: control.text('Helper Text'),
    inputType: control.select('Input Type', [
      { label: 'Text',   value: 'text'   },
      { label: 'Email',  value: 'email'  },
      { label: 'URL',    value: 'url'    },
      { label: 'Phone',  value: 'tel'    },
      { label: 'Number', value: 'number' },
    ]),
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
  <input
    class="pb-forms-control"
    id="pb-${props.name}"
    type="${props.inputType}"
    name="${props.name}"${raw(placeholderAttr)}${raw(requiredAttr)}
  >
  ${raw(helper)}
</div>`,
    }
  },
})
