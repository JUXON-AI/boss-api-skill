// Verified local BOSS API cursor: maxMsgId, not lastMsgId/count/page.
export async function readCompleteHistory(request, {uid, securityId}, {maxPages = 50} = {}) {
  const all = new Map(), pages = [];
  let cursor = 0;
  let peer;
  for (let page = 1; page <= maxPages; page++) {
    const response = await request({uid, securityId, maxMsgId: cursor});
    const data = response?.zpData;
    if (response?.code !== 0 || !Array.isArray(data?.messages) || typeof data.hasMore !== 'boolean') throw new Error('History response schema changed');
    let added = 0;
    for (const m of data.messages) {
      const other = m.from?.uid === uid ? m.to?.uid : m.to?.uid === uid ? m.from?.uid : null;
      if (!Number.isSafeInteger(Number(m.mid)) || !Number.isSafeInteger(other) || other <= 0 || other === uid || (peer !== undefined && peer !== other)) throw new Error('History identity or message ID invalid');
      peer = other;
      const key = String(m.mid);
      if (!all.has(key)) { all.set(key, m); added++; }
      else {
        const old = all.get(key);
        if (old.time !== m.time || old.from.uid !== m.from.uid || old.to.uid !== m.to.uid || JSON.stringify(old.body) !== JSON.stringify(m.body)) throw new Error('History overlapping message changed');
      }
    }
    pages.push({page, cursor, count: data.messages.length, added, hasMore: data.hasMore});
    // The API can return only the inclusive boundary again on its terminal page.
    if (data.hasMore === false) {
      const messages = pages.length === 1 ? data.messages : [...all.values()].sort((a, b) => a.time - b.time || Number(a.mid) - Number(b.mid));
      return {...response, zpData: {...data, messages, hasMore: false}, pagination: {pages, terminalHasMore: false}};
    }
    const next = Math.min(...data.messages.map(m => Number(m.mid)));
    if (!added || !Number.isSafeInteger(next) || next <= 0 || (cursor && next >= cursor)) throw new Error('History pagination made no progress');
    cursor = next;
  }
  throw new Error('History pagination exceeded bounded page limit');
}
