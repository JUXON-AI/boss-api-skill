import assert from 'node:assert/strict';

// Internal review builders use onsite/days; the notification contract uses
// location/onsite_days. Preserve every evidence value while normalizing keys.
export function normalizeTalentGateNotes(notes, requiredKeys = null) {
  assert.ok(notes && typeof notes === 'object' && Array.isArray(notes.gates));
  const aliases = requiredKeys ? {} : {onsite: 'location', days: 'onsite_days'};
  const gates = notes.gates.map(g => {
    assert.ok(g && typeof g === 'object');
    return {...g, condition: aliases[g.condition] ?? g.condition};
  });
  assert.deepEqual(gates.map(g => g.condition).sort(),
    requiredKeys ? [...requiredKeys].sort() : ['arrival', 'duration', 'location', 'onsite_days', 'salary', 'school']);
  return {...notes, gates};
}
