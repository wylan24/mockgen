import { useEffect, useState } from 'react';
import { getTask, listTasks, type Page, type RequestOptions, type Task } from './api';

const API = '/api';

export function App() {
  const [page, setPage] = useState(1);
  const [tasks, setTasks] = useState<Page<Task>>();
  const [selected, setSelected] = useState<Task>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  // Toggles that use mockgen's per-request headers to show error and loading states.
  const [simulateError, setSimulateError] = useState(false);
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    const options: RequestOptions = { mockStatus: simulateError ? 500 : undefined, mockDelay: slow ? 1500 : undefined };
    setLoading(true);
    setError(undefined);
    listTasks(API, page, options)
      .then(setTasks)
      .catch((err: Error) => setError(err.message))
      .finally(() => setLoading(false));
  }, [page, simulateError, slow]);

  const pages = tasks ? Math.ceil(tasks.total / tasks.perPage) : 1;

  return (
    <main style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 720, margin: '2rem auto', padding: '0 1rem' }}>
      <h1>Tasks</h1>
      <p>
        Served by <code>mockgen serve api/openapi.yaml</code>. The data is generated from the spec and is the same on
        every reload.
      </p>
      <label>
        <input type="checkbox" checked={simulateError} onChange={(e) => setSimulateError(e.target.checked)} /> Simulate a
        500 error
      </label>{' '}
      <label>
        <input type="checkbox" checked={slow} onChange={(e) => setSlow(e.target.checked)} /> Slow network (1.5 s)
      </label>

      {loading && <p>Loading…</p>}
      {error && (
        <p role="alert" style={{ color: 'crimson' }}>
          {error}
        </p>
      )}

      {tasks && !error && (
        <>
          <ul style={{ listStyle: 'none', padding: 0 }}>
            {tasks.data.map((task) => (
              <li key={task.id} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '8px 0' }}>
                <img src={task.assignee.avatarUrl} alt="" width={32} height={32} style={{ borderRadius: '50%' }} />
                <button onClick={() => getTask(API, task.id).then(setSelected)} style={{ all: 'unset', cursor: 'pointer' }}>
                  #{task.id} {task.title}
                </button>
                <small>
                  {task.status} · {task.priority}
                </small>
              </li>
            ))}
          </ul>
          <button disabled={page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </button>{' '}
          Page {page} of {pages}{' '}
          <button disabled={page >= pages} onClick={() => setPage(page + 1)}>
            Next
          </button>
        </>
      )}

      {selected && (
        <section>
          <h2>Task #{selected.id}</h2>
          <p>{selected.title}</p>
          <p>
            Assigned to {selected.assignee.firstName} {selected.assignee.lastName} ({selected.assignee.email})
          </p>
          <p>Due: {selected.dueDate ?? 'no due date'}</p>
        </section>
      )}
    </main>
  );
}
