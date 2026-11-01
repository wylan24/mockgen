import Link from 'next/link';
import { listTasks } from './api';

// Rendered per request on the server, so it always shows what the API returns.
export const dynamic = 'force-dynamic';

export default async function TasksPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const page = Math.max(1, Number((await searchParams).page) || 1);
  const tasks = await listTasks(page);
  const pages = Math.ceil(tasks.total / tasks.perPage);

  return (
    <main>
      <h1>Tasks</h1>
      <p>
        Rendered on the server from <code>mockgen serve api/openapi.yaml</code>.
      </p>
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {tasks.data.map((task) => (
          <li key={task.id} style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '6px 0' }}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={task.assignee.avatarUrl} alt="" width={28} height={28} style={{ borderRadius: '50%' }} />
            <Link href={`/tasks/${task.id}`}>
              #{task.id} {task.title}
            </Link>
            <small>
              {task.status} · {task.priority}
            </small>
          </li>
        ))}
      </ul>
      <nav style={{ display: 'flex', gap: 12 }}>
        {page > 1 && <Link href={`/?page=${page - 1}`}>Previous</Link>}
        <span>
          Page {page} of {pages}
        </span>
        {page < pages && <Link href={`/?page=${page + 1}`}>Next</Link>}
      </nav>
    </main>
  );
}
