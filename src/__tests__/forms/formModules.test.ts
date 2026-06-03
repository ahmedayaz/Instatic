import { describe, expect, it } from 'bun:test'
import {
  CheckboxModule,
  FormMessageModule,
  FormModule,
  InputModule,
  LabelModule,
  OptionGroupModule,
  OptionModule,
  RadioModule,
  SelectModule,
  SubmitModule,
  TextareaModule,
} from '@modules/base/forms'

describe('base form primitive modules', () => {
  // ISS-027: a control with fieldId set but `name` left blank must still render
  // a `name` attribute (falling back to fieldId) — otherwise the browser's
  // FormData omits the field and the submitted value is silently dropped. The
  // snapshot + validator already key by `name || fieldId`, so render must agree.
  it('falls back to fieldId for the name attribute when name is blank', () => {
    expect(InputModule.render({ ...InputModule.defaults, fieldId: 'email', name: '' }).html)
      .toContain('name="email"')
    expect(TextareaModule.render({ ...TextareaModule.defaults, fieldId: 'bio', name: '' }).html)
      .toContain('name="bio"')
    expect(SelectModule.render({ ...SelectModule.defaults, fieldId: 'country', name: '' }, []).html)
      .toContain('name="country"')
    expect(CheckboxModule.render({ ...CheckboxModule.defaults, fieldId: 'optin', name: '' }, []).html)
      .toContain('name="optin"')
  })

  it('renders a CMS-native form with runtime metadata and children', () => {
    const output = FormModule.render({
      mode: 'cms',
      formId: 'newsletter',
      targetTableId: 'newsletter_submissions',
      successBehavior: 'message',
      successMessage: 'Thanks',
      redirectUrl: '',
      honeypotName: 'company',
      minSubmitSeconds: 2,
    }, ['<input name="email">'])

    expect(output.html).toContain('<form')
    expect(output.html).toContain('data-instatic-form-id="newsletter"')
    expect(output.html).toContain('data-instatic-form-mode="cms"')
    expect(output.html).toContain('data-instatic-success-message="Thanks"')
    expect(output.html).toContain('<input type="text" name="company"')
    expect(output.html).toContain('<input name="email">')
    expect(output.html).toContain('</form>')
  })

  it('renders labels and text-like controls as semantic HTML', () => {
    expect(LabelModule.render({ text: 'Email', targetMode: 'auto', targetId: '' }, []).html)
      .toBe('<label data-instatic-label-target="auto">Email</label>')

    const input = InputModule.render({
      inputType: 'email',
      fieldId: 'email',
      name: 'email',
      id: 'email-input',
      placeholder: 'you@example.com',
      value: '',
      required: true,
      disabled: false,
      readOnly: false,
      autocomplete: 'email',
      min: '',
      max: '',
      minLength: 0,
      maxLength: 320,
      pattern: '',
    }, []).html

    expect(input).toContain('<input')
    expect(input).toContain('type="email"')
    expect(input).toContain('data-instatic-form-control="input"')
    expect(input).toContain('data-instatic-field-id="email"')
    expect(input).toContain('name="email"')
    expect(input).toContain('required')
    expect(input).toContain('autocomplete="email"')
  })

  it('renders textarea, select, option, and option-group primitives', () => {
    expect(TextareaModule.render({
      fieldId: 'message',
      name: 'message',
      id: 'message-input',
      placeholder: 'Message',
      value: 'Hello',
      required: false,
      disabled: false,
      readOnly: false,
      rows: 4,
      minLength: 0,
      maxLength: 500,
    }, []).html).toBe('<textarea data-instatic-form-control="textarea" data-instatic-field-id="message" name="message" id="message-input" placeholder="Message" rows="4" maxlength="500">Hello</textarea>')

    expect(OptionModule.render({ value: 'pro', label: 'Pro', selected: true, disabled: false }, []).html)
      .toBe('<option value="pro" selected>Pro</option>')

    expect(OptionGroupModule.render({ label: 'Plans', disabled: false }, ['<option>Pro</option>']).html)
      .toBe('<optgroup label="Plans"><option>Pro</option></optgroup>')

    expect(SelectModule.render({
      fieldId: 'plan',
      name: 'plan',
      id: 'plan-select',
      required: true,
      disabled: false,
      multiple: false,
    }, ['<option value="pro">Pro</option>']).html)
      .toBe('<select data-instatic-form-control="select" data-instatic-field-id="plan" name="plan" id="plan-select" required><option value="pro">Pro</option></select>')
  })

  it('renders choice controls, submit, and form messages', () => {
    expect(CheckboxModule.render({
      fieldId: 'agree',
      name: 'agree',
      id: 'agree-input',
      value: 'yes',
      checked: true,
      required: true,
      disabled: false,
    }, []).html).toBe('<input type="checkbox" data-instatic-form-control="checkbox" data-instatic-field-id="agree" name="agree" id="agree-input" value="yes" checked required>')

    expect(RadioModule.render({
      fieldId: 'plan',
      name: 'plan',
      id: 'plan-pro',
      value: 'pro',
      checked: false,
      required: false,
      disabled: false,
    }, []).html).toBe('<input type="radio" data-instatic-form-control="radio" data-instatic-field-id="plan" name="plan" id="plan-pro" value="pro">')

    expect(SubmitModule.render({ label: 'Subscribe', disabled: false, formId: '' }, []).html)
      .toBe('<button type="submit">Subscribe</button>')

    expect(FormMessageModule.render({
      formId: 'newsletter',
      kind: 'success',
      text: 'Thanks',
    }, []).html).toBe('<div data-instatic-form-message="success" data-instatic-form-id="newsletter" role="status">Thanks</div>')
  })
})
