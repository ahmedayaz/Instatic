/**
 * Forms Builder — `pagebuilder.forms.radio-group`
 *
 * A group of radio buttons. Options are configured as a newline-separated
 * "label:value" or just "value" list.
 */
import { control, defineModule, html, raw } from '@pagebuilder/plugin-sdk'

function parseOptions(rawStr: string): Array<{ label: string; value: string }> {
  return rawStr
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
  id: 'pagebuilder.forms.radio-group',
  name: 'Radio Group',
  description: 'A group of mutually exclusive radio buttons.',
  category: 'Forms',
  htmlTag: 'fieldset',
  canHaveChildren: false,
  defaults: {
    name: 'pick',
    label: 'Pick one',
    required: false,
    helperText: '',
    options: 'Yes:yes\nNo:no\nMaybe:maybe',
  },
  schema: {
    name: control.text('Field Name', {
      placeholder: 'pick',
      description: 'HTML name attribute — shared by all radio inputs in the group.',
    }),
    label: control.text('Legend Label'),
    required: control.toggle('Required'),
    helperText: control.text('Helper Text'),
    options: control.textarea('Options', {
      rows: 4,
      description: 'One option per line. Format: "Label:value" or just "value".',
      placeholder: 'Yes:yes\nNo:no',
    }),
  },
  render: ({ props }) => {
    const asterisk = props.required
      ? raw('<span class="pb-forms-required" aria-hidden="true">*</span>')
      : raw('')
    const helper = props.helperText
      ? html`<small class="pb-forms-help">${props.helperText}</small>`
      : ''
    const opts = parseOptions(String(props.options))
    const radioInputs = opts
      .map(
        (o) =>
          html`<label class="pb-forms-radio-label">
    <input class="pb-forms-radio" type="radio" name="${props.name}" value="${o.value}"${raw(props.required ? ' required' : '')}>
    ${o.label}
  </label>`,
      )
      .join('\n  ')
    return {
      html: html`<fieldset class="pb-forms-field pb-forms-fieldset">
  <legend class="pb-forms-label">${props.label}${asterisk}</legend>
  ${raw(radioInputs)}
  ${raw(helper)}
</fieldset>`,
      css: `
.pb-forms-fieldset{border:none;padding:0;margin:0;}
.pb-forms-fieldset legend.pb-forms-label{padding:0;margin-bottom:6px;}
.pb-forms-radio-label{display:flex;align-items:center;gap:8px;font-size:0.9375rem;cursor:pointer;margin-bottom:6px;}
.pb-forms-radio{width:15px;height:15px;flex-shrink:0;}
`,
    }
  },
})
