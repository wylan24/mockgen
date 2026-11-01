// The same client code, tested against an in-process mock server. No network,
// no fixtures to maintain: the data comes from api/openapi.yaml and is stable.
import { createMockServer, type MockServer } from '@wylan24/mockgen';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiError, getTask, listTasks } from './api';

let mock: MockServer;
let url: string;

beforeAll(async () => {
  mock = await createMockServer({ spec: 'api/openapi.yaml', seed: 1 });
  url = await mock.listen(0); // any free port
});
afterAll(() => mock.close());

describe('tasks client', () => {
  it('lists a page of tasks', async () => {
    const page = await listTasks(url, 2);
    expect(page.page).toBe(2);
    expect(page.data).toHaveLength(5);
    expect(page.total).toBe(50);
  });

  it('returns the same task from the list and the detail route', async () => {
    const [first] = (await listTasks(url)).data;
    expect(await getTask(url, first!.id)).toEqual(first);
  });

  it('surfaces server errors', async () => {
    await expect(listTasks(url, 1, { mockStatus: 500 })).rejects.toBeInstanceOf(ApiError);
    await expect(getTask(url, 1, { mockStatus: 404 })).rejects.toMatchObject({ status: 404 });
  });
});
