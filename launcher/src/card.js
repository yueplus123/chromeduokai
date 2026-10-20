// 卡信息的整理与校验(纯函数,便于测试)
const digits = (s) => String(s || '').replace(/\D/g, '');

function normalizeCard(c = {}) {
  return { holder: String(c.holder || '').trim(), number: digits(c.number), exp: String(c.exp || '').trim(), cvv: digits(c.cvv) };
}

const isEmptyCard = (c) => !c.number && !c.holder && !c.exp && !c.cvv;

// 返回错误文案,没问题返回空串
function validateCard(c) {
  if (!c.number) return '请填写卡号';
  if (c.number.length < 12 || c.number.length > 19) return '卡号长度应为 12–19 位';
  if (c.cvv && (c.cvv.length < 3 || c.cvv.length > 4)) return 'CVV 应为 3–4 位';
  if (c.exp && !/^(0[1-9]|1[0-2])\s*\/\s*(\d{2}|\d{4})$/.test(c.exp)) return '有效期格式应为 MM/YY';
  return '';
}

const last4 = (number) => number.slice(-4);

module.exports = { normalizeCard, isEmptyCard, validateCard, last4 };
