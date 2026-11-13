const crypto = require('crypto');

const hardDeniedControl = /\b(password|passcode|otp|cvv|cvc|card\s*number|credit\s*card|bank\s*account|routing\s*number|payment|pay\b|checkout|billing|transfer|wire|withdraw|purchase|buy\s*now|place\s*order|call|video\s*call|voice\s*call|credential|secret|api[_ -]?key|token)\b/i;
const messageComposeControl = /\b(message input|type a message|compose message|ask anything|chat input|prompt input|message box|soan tin|nhap tin nhan|noi dung tin nhan)\b/i;
const approvalControlRules = [
  { category: 'delete', test: /\b(delete|remove|trash|discard|erase)\b/i },
  { category: 'upload', test: /\b(upload|attach|choose\s*file|select\s*file)\b/i },
  { category: 'download', test: /\b(download|save\s+as)\b/i },
  { category: 'login', test: /\b(sign\s*in|log\s*in|login)\b/i },
  { category: 'send', test: /\b(send|message|gui)\b/i },
  { category: 'submit', test: /\b(submit|nop)\b/i },
  { category: 'save', test: /\b(save|luu)\b/i },
  { category: 'publish', test: /\b(publish)\b/i },
  { category: 'post', test: /\b(post)\b/i },
  { category: 'reply', test: /\b(reply)\b/i },
  { category: 'comment', test: /\b(comment)\b/i },
  { category: 'confirm', test: /\b(confirm|yes|ok\b)\b/i },
  { category: 'apply', test: /\b(apply)\b/i },
  { category: 'register', test: /\b(register|sign\s*up)\b/i },
  { category: 'book', test: /\b(book)\b/i },
  { category: 'reserve', test: /\b(reserve)\b/i },
  { category: 'create', test: /\b(create|new\b)\b/i },
];

function labelOf(control) {
  return `${control?.name || ''} ${control?.automationId || ''} ${control?.className || ''} ${control?.controlType || ''}`.normalize('NFKC');
}

function createDesktopCapabilityPolicy(secret) {
  if (!secret) throw new Error('Desktop capability policy requires companion secret.');
  const usedCapabilityUseIds = new Map();

  function classifyControl(control, action) {
    const label = labelOf(control);
    if (control?.password || hardDeniedControl.test(label)) return { blocked: true, category: 'hard_deny', reason: 'platform-hard-denied' };
    if (action === 'set_text' && messageComposeControl.test(label)) return { blocked: false, category: 'send', mode: 'presence' };
    if (action === 'invoke') {
      for (const rule of approvalControlRules) if (rule.test.test(label)) return { blocked: false, category: rule.category, mode: 'consume' };
    }
    return { blocked: false, category: null, mode: null };
  }

  function verifyApproval(approval, control, category, mode, now = Date.now()) {
    if (!approval || typeof approval !== 'object') throw new Error(`A signed ${category} capability proof is required.`);
    const fields = [
      String(approval.version || ''), String(approval.leaseId || ''), String(approval.runId || ''), String(approval.app || ''),
      String(approval.category || ''), String(approval.mode || ''), String(approval.windowId || ''), String(approval.selectorId || ''),
      String(approval.useId || ''), String(approval.expiresAt || ''), String(approval.issuedAt || ''),
    ];
    if (fields[0] !== 'desktop-capability-v1') throw new Error('Unsupported desktop capability proof version.');
    if (fields[4] !== category || fields[5] !== mode) throw new Error('Desktop capability proof category/mode mismatch.');
    if (fields[6] !== String(control?.windowId || '') || fields[7] !== String(control?.selectorId || '')) throw new Error('Desktop capability proof is bound to a different selector/window.');
    const expiresAt = Date.parse(fields[9]);
    const issuedAt = Date.parse(fields[10]);
    if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new Error('Desktop capability proof is expired.');
    if (!Number.isFinite(issuedAt) || issuedAt > now + 60_000 || now - issuedAt > 5 * 60_000) throw new Error('Desktop capability proof issue time is invalid or stale.');
    const signature = String(approval.signature || '');
    if (!/^[a-f0-9]{64}$/i.test(signature)) throw new Error('Desktop capability proof signature is invalid.');
    const expected = crypto.createHmac('sha256', secret).update(fields.join('\n'), 'utf8').digest('hex');
    const suppliedBuffer = Buffer.from(signature, 'hex');
    const expectedBuffer = Buffer.from(expected, 'hex');
    if (suppliedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) throw new Error('Desktop capability proof signature check failed.');
    for (const [useId, expiry] of usedCapabilityUseIds) if (expiry <= now) usedCapabilityUseIds.delete(useId);
    if (mode === 'consume') {
      const useId = fields[8];
      if (!useId) throw new Error('Consumed desktop capability proof requires a one-time useId.');
      if (usedCapabilityUseIds.has(useId)) throw new Error('Desktop capability proof was already consumed and cannot be replayed.');
      usedCapabilityUseIds.set(useId, expiresAt);
    }
    return true;
  }

  return { classifyControl, verifyApproval, usedCapabilityUseIds };
}

module.exports = { createDesktopCapabilityPolicy, hardDeniedControl, messageComposeControl, approvalControlRules };
