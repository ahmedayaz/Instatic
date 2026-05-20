/**
 * Forms Builder — module barrel.
 *
 * Collects all canvas modules and re-exports them as a typed array for
 * `definePlugin({ modules: [...] })`.
 */
import form from './form'
import input from './input'
import textarea from './textarea'
import select from './select'
import checkbox from './checkbox'
import radio from './radio'
import submit from './submit'
import honeypot from './honeypot'

const modules = [form, input, textarea, select, checkbox, radio, submit, honeypot]

export default modules
