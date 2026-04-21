// background.js - Manifest V3 Service Worker
// Handles bulk-send sessions: iterates prompts, injects into active tab

const ALARM_NAME = 'prompt-blaster-tick';

// State (persisted in chrome.storage.session for cross-popup persistence)
async function getSession() {
  const data = await chrome.storage.session.get('blasterSession');
  return data.blasterSession || null;
}
async function setSession(s) {
  await chrome.storage.session.set({ blasterSession: s });
}
async function clearSession() {
  await chrome.storage.session.remove('blasterSession');
}

// Message Router
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'START_BULK_SEND': {
        const { prompts, delayMs, tabId, selector } = msg.payload;
        if (!prompts || !prompts.length) { sendResponse({ ok: false, error: 'No prompts' }); return; }
        const session = { prompts, index: 0, delayMs: delayMs || 3000, tabId, selector: selector || '', status: 'running', results: [] };
        await setSession(session);
        await sendNextPrompt(session);
        sendResponse({ ok: true });
        break;
      }
      case 'PAUSE_BULK_SEND': {
        const s = await getSession();
        if (s) { s.status = 'paused'; await setSession(s); }
        chrome.alarms.clear(ALARM_NAME);
        sendResponse({ ok: true });
        break;
      }
      case 'RESUME_BULK_SEND': {
        const s = await getSession();
        if (s && s.status === 'paused') { s.status = 'running'; await setSession(s); await sendNextPrompt(s); }
        sendResponse({ ok: true });
        break;
      }
      case 'STOP_BULK_SEND': {
        chrome.alarms.clear(ALARM_NAME);
        await clearSession();
        sendResponse({ ok: true });
        break;
      }
      case 'GET_STATUS': {
        sendResponse({ session: await getSession() });
        break;
      }
      case 'PROMPT_RESULT': {
        const s = await getSession();
        if (s) {
          s.results.push({ index: msg.payload.index, success: msg.payload.success, error: msg.payload.error });
          s.index += 1;
          await setSession(s);
          chrome.runtime.sendMessage({ type: 'PROGRESS_UPDATE', session: s }).catch(() => {});
          if (s.index < s.prompts.length && s.status === 'running') {
            chrome.alarms.create(ALARM_NAME, { delayInMinutes: s.delayMs / 60000 });
          } else if (s.index >= s.prompts.length) {
            s.status = 'done'; await setSession(s);
            chrome.runtime.sendMessage({ type: 'BULK_SEND_DONE', session: s }).catch(() => {});
          }
        }
        sendResponse({ ok: true });
        break;
      }
      default: sendResponse({ ok: false, error: 'Unknown type' });
    }
  })();
  return true;
});

// Alarm: fire next prompt after delay
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  const s = await getSession();
  if (s && s.status === 'running') await sendNextPrompt(s);
});

// Inject current prompt via scripting API
async function sendNextPrompt(session) {
  const { prompts, index, tabId, selector } = session;
  if (index >= prompts.length) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: injectPrompt,
      args: [prompts[index], selector, index]
    });
  } catch (err) {
    const s = await getSession();
    if (!s) return;
    s.results.push({ index, success: false, error: err.message });
    s.index += 1;
    await setSession(s);
    if (s.index < s.prompts.length && s.status === 'running') {
      chrome.alarms.create(ALARM_NAME, { delayInMinutes: s.delayMs / 60000 });
    } else {
      s.status = 'done'; await setSession(s);
      chrome.runtime.sendMessage({ type: 'BULK_SEND_DONE', session: s }).catch(() => {});
    }
  }
}

// Runs inside the target page
function injectPrompt(promptText, selector, index) {
  const SELECTORS = [
    selector,
    '#prompt-textarea',
    'div[contenteditable="true"][data-id]',
    '.ProseMirror[contenteditable="true"]',
    'div[contenteditable="true"].ProseMirror',
    'rich-textarea div[contenteditable="true"]',
    'textarea:not([disabled]):not([readonly])',
    'input[type="text"]:not([disabled]):not([readonly])',
    'div[contenteditable="true"]:not([readonly])'
  ].filter(Boolean);

  let el = null;
  for (const sel of SELECTORS) {
    try { const f = document.querySelector(sel); if (f) { el = f; break; } } catch (_) {}
  }
  if (!el) {
    chrome.runtime.sendMessage({ type: 'PROMPT_RESULT', payload: { index, success: false, error: 'No input found' } });
    return;
  }

  if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
    const proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) setter.call(el, promptText); else el.value = promptText;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    el.focus();
    document.execCommand('selectAll', false, null);
    document.execCommand('insertText', false, promptText);
    if (!el.textContent.includes(promptText.slice(0, 15))) {
      el.textContent = promptText;
      el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: promptText }));
    }
  }

  setTimeout(() => {
    const SUBMIT = [
      'button[data-testid="send-button"]',
      'button[aria-label="Send message"]',
      'button[aria-label="Send Message"]',
      'button[type="submit"]',
      'button.send-button',
      'button[data-qa="composer_send_button"]'
    ];
    let sent = false;
    for (const sel of SUBMIT) {
      const btn = document.querySelector(sel);
      if (btn && !btn.disabled) { btn.click(); sent = true; break; }
    }
    if (!sent) el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }));
    chrome.runtime.sendMessage({ type: 'PROMPT_RESULT', payload: { index, success: true } });
  }, 400);
}
