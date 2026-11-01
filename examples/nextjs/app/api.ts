// Server-side client for the Tasks API in api/openapi.yaml. In development API_URL
// points at mockgen (the default below); in production, at the real API.
const API_URL = process.env.API_URL ?? 'http://127.0.0.1:4010';

export interface User {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  avatarUrl: string;
}

export interface Task {
  id: number;
  title: string;
  status: 'todo' | 'in_progress' | 'done';
  priority: 'low' | 'medium' | 'high';
  dueDate?: string | null;
  createdAt: string;
  assignee: User;
}

export interface Page<T> {
  data: T[];
  page: number;
  perPage: number;
  total: number;
}

/** Fetch JSON from the API; `undefined` for a 404. */
async function get<T>(path: string): Promise<T | undefined> {
  const res = await fetch(`${API_URL}${path}`, { cache: 'no-store' });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`GET ${path} failed with status ${res.status}`);
  return res.json() as Promise<T>;
}

export const listTasks = async (page: number) => (await get<Page<Task>>(`/tasks?page=${page}&limit=10`))!;
export const getTask = (id: number) => get<Task>(`/tasks/${id}`);
