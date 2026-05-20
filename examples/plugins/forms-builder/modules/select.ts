/**
 * Forms Builder — `pagebuilder.forms.select`
 *
 * Dropdown select field. Options are configured as a newline-separated
 * "label:value" or just "value" list in a textarea prop.
 */
import { control, defineModule, html, raw } from '@pagebuilder/plugin-sdk'

function parseOptions(raw: string): Array<{ label: string; value: string }> {
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const sep = line.indexOf(':')
      if (sep === -1) return { label: line, value: line }
      return { label: line.slice(0, sep).trim(), value: line.slice(sep + 1).trim() }
    })
}

export default defineModule({
  id: 'pagebuilder.forms.select',
  name: 'Select',
  description: 'Dropdown selection field.',
  category: 'Forms',
  htmlTag: 'div',
  canHaveChildren: false,
  defaults: {
    name: 'choice',
    label: 'Choose an option',
    required: false,
    helperText: '',
    options: 'Option A:a\nOption B:b\nOption C:c',
  },
  schema: {
    name: control.text('Field Name', {
      placeholder: 'choice',
      description: 'HTML name attribute — must be unique within the form.',
    }),
    label: control.text('Label'),
    required: control.toggle('Required'),
    helperText: control.text('Helper Text'),
    options: control.textarea('Options', {
      rows: 5,
      description: 'One option per line. Format: "Label:value" or just "value".',
      placeholder: 'Option A:a\nOption B:b',
    }),
  },
  render: ({ props }) => {
    const requiredAttr = props.required ? ' required' : ''
    const asterisk = props.required
      ? raw('<span class="pb-forms-required" aria-hidden="true">*</span>')
      : raw('')
    const helper = props.helperText
      ? html`<small class="pb-forms-help">${props.helperText}</small>`
      : ''
    const opts = parseOptions(String(props.options))
    const optionsHtml = opts
      .map((o) => html`<option value="${o.value}">${o.label}</option>`)
      .join('\n  ')
    return {
      html: html`<div class="pb-forms-field">
  <label class="pb-forms-label" for="pb-${props.name}">${props.label}${asterisk}</label>
  <select class="pb-forms-control" id="pb-${props.name}" name="${props.name}"${raw(requiredAttr)}>
  ${raw(optionsHtml)}
  </select>
  ${raw(helper)}
</div>`,
    }
  },
})
