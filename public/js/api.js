async function request(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const text = await res.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`响应解析失败：${text.slice(0, 200)}`);
  }
  if (!res.ok || data.ok === false) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

export const api = {
  health: () => request('/api/health'),
  engines: () => request('/api/engines'),
  detect: () => request('/api/engines/detect', { method: 'POST' }),
  preview: (payload) => request('/api/preview', { method: 'POST', body: JSON.stringify(payload) }),
  stats: () => request('/api/stats'),

  datasets: () => request('/api/datasets'),
  dataset: (id) => request(`/api/datasets/${id}`),
  createDataset: (payload) => request('/api/datasets', { method: 'POST', body: JSON.stringify(payload) }),
  deleteDataset: (id) => request(`/api/datasets/${id}`, { method: 'DELETE' }),
  datasetContentUrl: (id) => `/api/datasets/${id}/content`,

  runs: (params = {}) => request(`/api/runs?${new URLSearchParams(params)}`),
  run: (id) => request(`/api/runs/${id}`),
  createRun: (payload) => request('/api/runs', { method: 'POST', body: JSON.stringify(payload) }),
  cancelRun: (id) => request(`/api/runs/${id}/cancel`, { method: 'POST' }),
  rerun: (id) => request(`/api/runs/${id}/rerun`, { method: 'POST' }),
  deleteRun: (id) => request(`/api/runs/${id}`, { method: 'DELETE' }),
  runLogs: (id) => fetch(`/api/runs/${id}/logs`).then((r) => r.text()),
  runArtifacts: (id) => request(`/api/runs/${id}/artifacts`),
  compare: (ids) => request(`/api/compare?ids=${ids.join(',')}`),
  logStreamUrl: (id) => `/api/runs/${id}/events`,
};
