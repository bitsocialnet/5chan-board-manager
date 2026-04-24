import envPaths from 'env-paths'

const paths = envPaths('5chan', { suffix: '' })

export const LOG_PATH = paths.log
export const LOG_FILE_PREFIX = '5chan_daemon_'
export const LOG_FILE_SUFFIX = '.log'
export const LOG_FILE_CAPACITY = 5
export const LOG_FILE_MAX_BYTES = 20_000_000
