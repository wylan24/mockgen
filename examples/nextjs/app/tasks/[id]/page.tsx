import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTask } from '../../api';

export const dynamic = 'force-dynamic';

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id < 1) notFound();
  const task = await getTask(id);
  if (!task) notFound();

  return (
    <main>
      <p>
        <Link href="/">← All tasks</Link>
      </p>
      <h1>
        Task #{task.id}: {task.title}
      </h1>
      <p>
        {task.status} · {task.priority} priority · due {task.dueDate ?? 'whenever'}
      </p>
      <p>
        Assigned to {task.assignee.firstName} {task.assignee.lastName} ({task.assignee.email})
      </p>
    </main>
  );
}
