/** Dictionaries for the session-list namespace (en and zh, matching dsh's own catalog). */
export const NS = 'session-list'

export const DICT_EN: Record<string, string> = {
  'session.new': 'New Session',
  'time.now': 'now',
  'time.minutes': '{n}min',
  'time.hours': '{n}h',
  'time.days': '{n}d',
  'time.months': '{n}mo',
  'time.years': '{n}y',
  'actions.archive': 'Archive session',
  'actions.copyId': 'Copy session ID',
}

export const DICT_ZH: Record<string, string> = {
  'session.new': '新会话',
  'time.now': '刚刚',
  'time.minutes': '{n}分钟',
  'time.hours': '{n}小时',
  'time.days': '{n}天',
  'time.months': '{n}个月',
  'time.years': '{n}年',
  'actions.archive': '归档会话',
  'actions.copyId': '复制会话 ID',
}
