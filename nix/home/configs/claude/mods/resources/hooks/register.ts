import type { Register } from 'claude-code'
import { registerResources } from './resources'

export const register: Register = (on, options) => registerResources(on, options)
