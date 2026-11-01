// A tiny client for the Tasks API in api/openapi.yaml. Nothing here knows about
// mockgen: the same code talks to the real API once it exists.

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

export interface RequestOptions {
  /** mockgen only: answer with this status instead, e.g. 500 to test error states. */
  mockStatus?: number;
  /** mockgen only: delay the response by this many milliseconds. */
  mockDelay?: number;
}

export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`Request failed with status ${status}`);
  }
}

async function get<T>(baseUrl: string, path: string, options: RequestOptions = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.mockStatus) headers['X-Mock-Status'] = String(options.mockStatus);
  if (options.mockDelay) headers['X-Mock-Delay'] = String(options.mockDelay);
  const res = await fetch(`${baseUrl}${path}`, { headers });
  if (!res.ok) throw new ApiError(res.status);
  return res.json() as Promise<T>;
}

export const listTasks = (baseUrl: string, page = 1, options?: RequestOptions) =>
  get<Page<Task>>(baseUrl, `/tasks?page=${page}&limit=5`, options);

export const getTask = (baseUrl: string, id: number, options?: RequestOptions) => get<Task>(baseUrl, `/tasks/${id}`, options);
