import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Plus } from 'lucide-react';
import { useCadStore } from '../store/useCadStore';

const tableHeaderCls = 'px-2 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-zinc-600 border-b border-zinc-300 bg-zinc-100';
const cellCls = 'px-2 py-1.5 border-b border-zinc-200 align-top';
const inputCls =
  'w-full bg-white border border-zinc-300 rounded py-1 px-2 text-xs text-zinc-900 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500';
const invalidInputCls = 'border-red-500 focus:ring-red-500 focus:border-red-500';

function evaluateExpressionLocal(
  expression: string,
  env: Record<string, number>,
  selfName?: string
): { ok: true; value: number } | { ok: false; message: string } {
  const trimmed = expression.trim();
  if (!trimmed) return { ok: false, message: 'Expression is empty' };
  if (!trimmed.startsWith('=')) {
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return { ok: false, message: 'Invalid numeric value' };
    return { ok: true, value: n };
  }
  const body = trimmed.slice(1).trim();
  if (!body) return { ok: false, message: 'Expression is empty' };
  if (selfName) {
    const selfRef = new RegExp(`\\b${selfName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (selfRef.test(body)) return { ok: false, message: 'Self reference is not allowed' };
  }
  let unknownToken: string | null = null;
  const replaced = body.replace(/[A-Za-z_][A-Za-z0-9_]*/g, (token) => {
    if (Object.prototype.hasOwnProperty.call(env, token)) return String(env[token]);
    unknownToken = token;
    return token;
  });
  if (unknownToken) return { ok: false, message: `Unknown parameter: ${unknownToken}` };
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`return (${replaced});`);
    const result = Number(fn());
    if (!Number.isFinite(result)) return { ok: false, message: 'Expression result is not finite' };
    return { ok: true, value: result };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'Invalid expression' };
  }
}

export const ParametersDialog = () => {
  const {
    isParametersDialogOpen,
    closeParametersDialog,
    userParameters,
    dimensionParameters,
    addUserParameter,
    updateUserParameter,
    updateDimensionParameter,
  } = useCadStore();

  const [showUser, setShowUser] = useState(true);
  const [showDim, setShowDim] = useState(true);
  const [error, setError] = useState<string>('');
  const [userDrafts, setUserDrafts] = useState<Record<string, { name: string; expression: string; notes: string }>>({});
  const [dimDrafts, setDimDrafts] = useState<Record<string, { expression: string; notes: string }>>({});

  useEffect(() => {
    if (!isParametersDialogOpen) return;
    const users: Record<string, { name: string; expression: string; notes: string }> = {};
    for (const p of userParameters) {
      users[p.id] = { name: p.name, expression: p.expression, notes: p.notes };
    }
    const dims: Record<string, { expression: string; notes: string }> = {};
    for (const p of dimensionParameters) {
      dims[p.id] = { expression: p.expression, notes: p.notes };
    }
    setUserDrafts(users);
    setDimDrafts(dims);
    setError('');
  }, [isParametersDialogOpen, userParameters, dimensionParameters]);

  if (!isParametersDialogOpen) return null;

  const onAddUserParameter = () => {
    const res = addUserParameter();
    if (!res.success) setError(res.message);
    else setError('');
  };

  const onCancel = () => {
    closeParametersDialog();
  };

  const onUpdate = () => {
    for (const p of userParameters) {
      const d = userDrafts[p.id] ?? { name: p.name, expression: p.expression, notes: p.notes };
      const res = updateUserParameter(p.id, { name: d.name, expression: d.expression, notes: d.notes });
      if (!res.success) {
        setError(res.message);
        return;
      }
    }
    for (const p of dimensionParameters) {
      const d = dimDrafts[p.id] ?? { expression: p.expression, notes: p.notes };
      const res = updateDimensionParameter(p.id, { expression: d.expression, notes: d.notes });
      if (!res.success) {
        setError(res.message);
        return;
      }
    }
    setError('');
    closeParametersDialog();
  };

  const env: Record<string, number> = {};
  const userResultMap: Record<string, { ok: boolean; value?: number; message?: string }> = {};
  const dimResultMap: Record<string, { ok: boolean; value?: number; message?: string }> = {};
  let firstError = '';

  for (const p of userParameters) {
    const d = userDrafts[p.id] ?? { name: p.name, expression: p.expression, notes: p.notes };
    const res = evaluateExpressionLocal(d.expression, env, d.name);
    if (res.ok) {
      env[d.name] = res.value;
      userResultMap[p.id] = { ok: true, value: res.value };
    } else {
      userResultMap[p.id] = { ok: false, message: res.message };
      if (!firstError) firstError = `${d.name}: ${res.message}`;
    }
  }

  for (const p of dimensionParameters) {
    const d = dimDrafts[p.id] ?? { expression: p.expression, notes: p.notes };
    const res = evaluateExpressionLocal(d.expression, env, p.name);
    if (res.ok) {
      env[p.name] = res.value;
      dimResultMap[p.id] = { ok: true, value: res.value };
    } else {
      dimResultMap[p.id] = { ok: false, message: res.message };
      if (!firstError) firstError = `${p.name}: ${res.message}`;
    }
  }

  const hasInvalidParameters = !!firstError;
  const bannerMessage = error || firstError;

  return (
    <div className="fixed inset-0 z-40 bg-black/40 flex items-center justify-center p-4">
      <div className="w-full max-w-6xl h-[80vh] bg-white rounded-lg border border-zinc-300 shadow-2xl flex flex-col overflow-hidden">
        <div className="px-4 py-3 border-b border-zinc-300">
          <h2 className="text-sm font-semibold text-zinc-900">Parameters</h2>
        </div>

        {bannerMessage && <div className="px-4 py-2 text-xs text-red-500 border-b border-zinc-300 bg-red-500/5">{bannerMessage}</div>}

        <div className="flex-1 overflow-auto p-4 space-y-4">
          <section className="border border-zinc-300 rounded-md overflow-hidden">
            <button
              onClick={() => setShowUser((v) => !v)}
              className="w-full px-3 py-2 text-left text-sm font-medium bg-zinc-50 border-b border-zinc-300 flex items-center gap-1.5"
            >
              {showUser ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              User Parameters
            </button>
            {showUser && (
              <div className="overflow-auto">
                <table className="w-full min-w-[720px] border-collapse">
                  <thead>
                    <tr>
                      <th className={`${tableHeaderCls} text-left`}>Name</th>
                      <th className={`${tableHeaderCls} text-left`}>Expression</th>
                      <th className={`${tableHeaderCls} text-left`}>Result</th>
                      <th className={`${tableHeaderCls} text-left`}>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {userParameters.map((p) => (
                      <tr key={p.id}>
                        <td className={cellCls}>
                          <input
                            className={inputCls}
                            value={userDrafts[p.id]?.name ?? p.name}
                            onChange={(e) => {
                              setUserDrafts((prev) => ({
                                ...prev,
                                [p.id]: {
                                  name: e.target.value,
                                  expression: prev[p.id]?.expression ?? p.expression,
                                  notes: prev[p.id]?.notes ?? p.notes,
                                },
                              }));
                              setError('');
                            }}
                          />
                        </td>
                        <td className={cellCls}>
                          <input
                            className={`${inputCls} ${!userResultMap[p.id]?.ok ? invalidInputCls : ''}`}
                            value={userDrafts[p.id]?.expression ?? p.expression}
                            onChange={(e) => {
                              setUserDrafts((prev) => ({
                                ...prev,
                                [p.id]: {
                                  name: prev[p.id]?.name ?? p.name,
                                  expression: e.target.value,
                                  notes: prev[p.id]?.notes ?? p.notes,
                                },
                              }));
                              setError('');
                            }}
                            placeholder='12.34 or =L1 + 2.0'
                          />
                        </td>
                        <td className={`${cellCls} text-xs ${userResultMap[p.id]?.ok ? 'text-zinc-800' : 'text-red-500 font-medium'}`}>
                          {userResultMap[p.id]?.ok ? userResultMap[p.id].value!.toFixed(4) : 'Invalid'}
                        </td>
                        <td className={cellCls}>
                          <input
                            className={inputCls}
                            value={userDrafts[p.id]?.notes ?? p.notes}
                            onChange={(e) => {
                              setUserDrafts((prev) => ({
                                ...prev,
                                [p.id]: {
                                  name: prev[p.id]?.name ?? p.name,
                                  expression: prev[p.id]?.expression ?? p.expression,
                                  notes: e.target.value,
                                },
                              }));
                              setError('');
                            }}
                            placeholder="Optional"
                          />
                        </td>
                      </tr>
                    ))}
                    {userParameters.length === 0 && (
                      <tr>
                        <td className={`${cellCls} text-xs text-zinc-500`} colSpan={4}>
                          No user parameters yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
                <div className="p-2 border-t border-zinc-300 bg-zinc-50">
                  <button
                    onClick={onAddUserParameter}
                    className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    Add Parameter
                  </button>
                </div>
              </div>
            )}
          </section>

          <section className="border border-zinc-300 rounded-md overflow-hidden">
            <button
              onClick={() => setShowDim((v) => !v)}
              className="w-full px-3 py-2 text-left text-sm font-medium bg-zinc-50 border-b border-zinc-300 flex items-center gap-1.5"
            >
              {showDim ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
              Dimensions
            </button>
            {showDim && (
              <div className="overflow-auto">
                <table className="w-full min-w-[960px] border-collapse">
                  <thead>
                    <tr>
                      <th className={`${tableHeaderCls} text-left`}>Name</th>
                      <th className={`${tableHeaderCls} text-left`}>Expression</th>
                      <th className={`${tableHeaderCls} text-left`}>Result</th>
                      <th className={`${tableHeaderCls} text-left`}>Notes</th>
                      <th className={`${tableHeaderCls} text-left`}>Parent</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dimensionParameters.map((p) => (
                      <tr key={p.id}>
                        <td className={`${cellCls} text-xs font-medium text-zinc-800`}>{p.name}</td>
                        <td className={cellCls}>
                          <input
                            className={`${inputCls} ${!dimResultMap[p.id]?.ok ? invalidInputCls : ''}`}
                            value={dimDrafts[p.id]?.expression ?? p.expression}
                            onChange={(e) => {
                              setDimDrafts((prev) => ({
                                ...prev,
                                [p.id]: {
                                  expression: e.target.value,
                                  notes: prev[p.id]?.notes ?? p.notes,
                                },
                              }));
                              setError('');
                            }}
                            placeholder='12.34 or =L1 + 2.0'
                          />
                        </td>
                        <td className={`${cellCls} text-xs ${dimResultMap[p.id]?.ok ? 'text-zinc-800' : 'text-red-500 font-medium'}`}>
                          {dimResultMap[p.id]?.ok ? dimResultMap[p.id].value!.toFixed(4) : 'Invalid'}
                        </td>
                        <td className={cellCls}>
                          <input
                            className={inputCls}
                            value={dimDrafts[p.id]?.notes ?? p.notes}
                            onChange={(e) => {
                              setDimDrafts((prev) => ({
                                ...prev,
                                [p.id]: {
                                  expression: prev[p.id]?.expression ?? p.expression,
                                  notes: e.target.value,
                                },
                              }));
                              setError('');
                            }}
                            placeholder="Optional"
                          />
                        </td>
                        <td className={`${cellCls} text-xs text-zinc-700`}>{p.parentFeatureName}</td>
                      </tr>
                    ))}
                    {dimensionParameters.length === 0 && (
                      <tr>
                        <td className={`${cellCls} text-xs text-zinc-500`} colSpan={5}>
                          No dimension parameters generated yet.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </div>

        <div className="px-4 py-3 border-t border-zinc-300 bg-white flex items-center justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded text-xs font-medium text-zinc-700 hover:text-zinc-900 hover:bg-zinc-100"
          >
            Cancel
          </button>
          <button
            onClick={onUpdate}
            disabled={hasInvalidParameters}
            className={`px-4 py-1.5 rounded text-xs font-medium text-white ${
              hasInvalidParameters ? 'bg-zinc-400 cursor-not-allowed' : 'bg-blue-600 hover:bg-blue-500'
            }`}
          >
            Update
          </button>
        </div>
      </div>
    </div>
  );
};
