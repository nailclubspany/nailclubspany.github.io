// Staff-app labels in English, Spanish, and Simplified Chinese. Each device
// picks one language with the header's EN / ES / 中文 switch (saved in
// localStorage; switching reloads the page). t() gives the text, say() puts
// it in an element.
//
// A key is the English text. A "|context" suffix picks a different
// translation for the same English word (e.g. 'Day|view' for the calendar's
// Day/Week toggle vs 'Day' the date field); only the part before "|" shows.
// Unknown keys fall back to English alone. tests/staff.test.mjs checks that
// every literal passed to say()/t()/lookup() in staff/*.mjs is listed here.
//
// No DOM at import time, so node tests can load it.

export const STRINGS = {
  // Shell
  'Requests': ['Solicitudes', '预约请求'],
  'Calendar': ['Calendario', '日历'],
  'Schedules': ['Horarios', '排班'],
  'Staff': ['Personal', '员工'],
  'Sign out': ['Cerrar sesión', '退出登录'],
  'Staff sign in': ['Acceso del personal', '员工登录'],
  'Email': ['Correo', '邮箱'],
  'Password': ['Contraseña', '密码'],
  'Sign in': ['Iniciar sesión', '登录'],
  'Sign-in failed — check the email and password.': ['No se pudo entrar. Revisa el correo y la contraseña.', '登录失败，请检查邮箱和密码。'],
  "Live booking isn't set up yet — see supabase/README.md.": ['Las reservas en línea aún no están configuradas.', '在线预约尚未设置。'],

  // Header
  'Sound on': ['Sonido activado', '提示音开'],
  'Sound off': ['Sonido desactivado', '提示音关'],

  // Shared
  'Please fill this in.': ['Completa este campo.', '请填写此项。'],
  'Please enter a valid email address.': ['Escribe un correo válido.', '请输入有效的邮箱地址。'],
  'Provider': ['Profesional', '技师'],
  'Day': ['Día', '日期'],
  'Length': ['Duración', '时长'],
  'Save': ['Guardar', '保存'],
  'Delete': ['Eliminar', '删除'],
  'Remove': ['Quitar', '移除'],
  'Close': ['Cerrar', '关闭'],
  'inactive': ['inactivo', '已停用'],
  'Could not save — try again.': ['No se pudo guardar. Inténtalo de nuevo.', '无法保存，请重试。'],
  'Could not delete — try again.': ['No se pudo eliminar. Inténtalo de nuevo.', '无法删除，请重试。'],
  'End must be after start': ['La hora de fin debe ser después del inicio', '结束时间必须晚于开始时间'],

  // Requests
  'Confirm': ['Confirmar', '确认'],
  'Decline': ['Rechazar', '拒绝'],
  'Tap again to decline': ['Toca otra vez para rechazar', '再点一次以拒绝'],
  'Confirm booking': ['Confirmar cita', '确认预约'],
  'No preference': ['Sin preferencia', '无指定技师'],
  'Choose a provider…': ['Elige un profesional…', '选择技师…'],
  '(no name given)': ['(sin nombre)', '（未留姓名）'],
  'No pending requests.': ['No hay solicitudes pendientes.', '没有待处理的预约请求。'],
  'Could not load requests — try again.': ['No se pudieron cargar las solicitudes. Inténtalo de nuevo.', '无法加载预约请求，请重试。'],
  'Could not confirm — try again.': ['No se pudo confirmar. Inténtalo de nuevo.', '无法确认，请重试。'],
  'Could not decline — try again.': ['No se pudo rechazar. Inténtalo de nuevo.', '无法拒绝，请重试。'],

  // Calendar
  'Day|view': ['Día', '日'],
  'Week': ['Semana', '周'],
  'No shift entered': ['Sin turno', '未排班'],
  'Pending': ['Pendiente', '待确认'],
  "Couldn't load the schedule — check the connection and try again.": ['No se pudo cargar el calendario. Revisa la conexión e inténtalo de nuevo.', '无法加载日程，请检查网络后重试。'],

  // Booking editor
  'New booking': ['Nueva cita', '新预约'],
  'Edit booking': ['Editar cita', '编辑预约'],
  'Name': ['Nombre', '姓名'],
  'Phone': ['Teléfono', '电话'],
  'Services': ['Servicios', '服务项目'],
  'Start': ['Inicio', '开始时间'],
  'Source': ['Origen', '来源'],
  'Status': ['Estado', '状态'],
  'Notes': ['Notas', '备注'],
  'Add booking': ['Agregar cita', '添加预约'],
  'Save changes': ['Guardar cambios', '保存修改'],
  'Cancel appointment': ['Cancelar cita', '取消预约'],
  'Could not cancel — try again.': ['No se pudo cancelar. Inténtalo de nuevo.', '无法取消，请重试。'],
  'Choose at least one service.': ['Elige al menos un servicio.', '请至少选择一项服务。'],
  'phone': ['teléfono', '电话'],
  'walk-in': ['sin cita', '现场'],
  'web': ['web', '网上'],
  'pending': ['pendiente', '待确认'],
  'confirmed': ['confirmada', '已确认'],
  'declined': ['rechazada', '已拒绝'],
  'cancelled': ['cancelada', '已取消'],

  // Schedules
  'Weekly hours': ['Horario semanal', '每周工作时间'],
  'These repeat every week. For one date (a day off or a short day), use Time off below.': [
    'Se repiten cada semana. Para una sola fecha (un día libre o un día corto), usa Tiempo libre abajo.',
    '每周重复。只改某一天（休息或提早下班）时，请用下方的“请假”。',
  ],
  'Sunday': ['Domingo', '星期日'],
  'Monday': ['Lunes', '星期一'],
  'Tuesday': ['Martes', '星期二'],
  'Wednesday': ['Miércoles', '星期三'],
  'Thursday': ['Jueves', '星期四'],
  'Friday': ['Viernes', '星期五'],
  'Saturday': ['Sábado', '星期六'],
  'Add shift': ['Agregar turno', '添加班次'],
  'Off': ['Libre', '休息'],
  'Save hours': ['Guardar horario', '保存工作时间'],
  'Saved.': ['Guardado.', '已保存。'],
  'Time off': ['Tiempo libre', '请假'],
  'All day': ['Todo el día', '全天'],
  'all day': ['todo el día', '全天'],
  'From': ['Desde', '从'],
  'To': ['Hasta', '到'],
  'Note (optional)': ['Nota (opcional)', '备注（可选）'],
  'Add time off': ['Agregar tiempo libre', '添加请假'],
  'No upcoming time off.': ['No hay tiempo libre próximo.', '暂无即将到来的请假。'],
  'Could not save hours — try again.': ['No se pudo guardar el horario. Inténtalo de nuevo.', '无法保存工作时间，请重试。'],
  "Couldn't load schedules — check the connection and try again.": ['No se pudieron cargar los horarios. Revisa la conexión e inténtalo de nuevo.', '无法加载排班，请检查网络后重试。'],

  // Staff (team)
  'Providers': ['Profesionales', '技师'],
  'Active': ['Activo', '在职'],
  'New provider name': ['Nombre del nuevo profesional', '新技师姓名'],
  'Add provider': ['Agregar profesional', '添加技师'],
  'No providers yet.': ['Aún no hay profesionales.', '还没有技师。'],
  "Couldn't load the team — check the connection and try again.": ['No se pudo cargar el equipo. Revisa la conexión e inténtalo de nuevo.', '无法加载团队，请检查网络后重试。'],
};

export const LANGS = [
  { code: 'en', label: 'EN', htmlLang: 'en' },
  { code: 'es', label: 'ES', htmlLang: 'es' },
  { code: 'zh', label: '中文', htmlLang: 'zh-Hans' },
];

const STORAGE_KEY = 'staff-lang';

function isLang(code) {
  return LANGS.some((l) => l.code === code);
}

function readSavedLang() {
  try {
    const saved = globalThis.localStorage?.getItem(STORAGE_KEY);
    return isLang(saved) ? saved : 'en';
  } catch {
    return 'en'; // storage blocked (private mode) or absent (node tests)
  }
}

let current = readSavedLang();

export function getLang() {
  return current;
}

export function setLang(code) {
  if (!isLang(code)) return;
  current = code;
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, code);
  } catch {
    // Not saved; still applies until the page reloads.
  }
}

// A message already in all three languages (e.g. one with a name in it).
export function tri(en, es, zh) {
  return { en, es, zh };
}

export function lookup(key) {
  const en = key.split('|')[0];
  const [es = '', zh = ''] = STRINGS[key] ?? [];
  return { en, es, zh };
}

// `msg` is a key or a tri() object; a missing translation falls back to English.
export function t(msg) {
  const m = typeof msg === 'string' ? lookup(msg) : msg;
  return m[current] || m.en;
}

// Text for a field that failed the browser's checks, in the chosen language
// (shown under the field by js/inline-errors.mjs). Other failures keep the
// message they were given.
export function fieldMessage(control) {
  if (control.validity.valueMissing) return t('Please fill this in.');
  if (control.validity.typeMismatch) return t('Please enter a valid email address.');
  return undefined;
}

// Sets `el`'s text to t(msg); '' / null clears it.
export function say(el, msg) {
  el.textContent = msg ? t(msg) : '';
  el.classList?.remove('is-ok');
  return el;
}

// Like say(), but for a passing confirmation such as 'Saved.': shown in the
// success colour and cleared after `ms` — unless something else (an error)
// has been written to `el` in the meantime.
export function sayBriefly(el, msg, ms = 3000) {
  clearTimeout(el.sayTimer);
  say(el, msg);
  el.classList?.add('is-ok');
  const shown = el.textContent;
  el.sayTimer = setTimeout(() => {
    if (el.textContent === shown) say(el, '');
  }, ms);
  return el;
}
