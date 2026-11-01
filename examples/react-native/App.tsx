import { StatusBar } from 'expo-status-bar';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, FlatList, Image, Platform, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';

// Where the mock server is, as seen from the device:
// - iOS simulator: the Mac itself, 127.0.0.1
// - Android emulator: the host machine is 10.0.2.2
// - a physical phone: your computer's LAN address. Set EXPO_PUBLIC_API_URL,
//   e.g. EXPO_PUBLIC_API_URL=http://192.168.1.20:4010 npm start
const API_URL = process.env.EXPO_PUBLIC_API_URL ?? (Platform.OS === 'android' ? 'http://10.0.2.2:4010' : 'http://127.0.0.1:4010');

interface Task {
  id: number;
  title: string;
  status: 'todo' | 'in_progress' | 'done';
  priority: 'low' | 'medium' | 'high';
  dueDate?: string | null;
  assignee: { firstName: string; lastName: string; avatarUrl: string };
}

interface Page {
  data: Task[];
  page: number;
  perPage: number;
  total: number;
}

const PER_PAGE = 10;

export default function App() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(Infinity);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  // mockgen's X-Mock-Status header: make every request fail, to build the error state.
  const [failRequests, setFailRequests] = useState(false);

  const load = useCallback(
    async (next: number, replace = false) => {
      setLoading(true);
      setError(undefined);
      try {
        const res = await fetch(`${API_URL}/tasks?page=${next}&limit=${PER_PAGE}`, {
          headers: failRequests ? { 'X-Mock-Status': '500' } : {},
        });
        if (!res.ok) throw new Error(`The API answered ${res.status}`);
        const body = (await res.json()) as Page;
        setTasks((current) => (replace ? body.data : [...current, ...body.data]));
        setPage(next);
        setTotal(body.total);
      } catch (err) {
        setError(`${(err as Error).message}. Is \`npm run mock\` running and reachable at ${API_URL}?`);
      } finally {
        setLoading(false);
      }
    },
    [failRequests],
  );

  useEffect(() => {
    load(1, true);
  }, [load]);

  return (
    <View style={styles.screen}>
      <StatusBar style="auto" />
      <Text style={styles.heading}>Tasks</Text>
      <Pressable onPress={() => setFailRequests(!failRequests)}>
        <Text style={styles.toggle}>{failRequests ? '☑' : '☐'} Simulate a 500 error</Text>
      </Pressable>
      {error && <Text style={styles.error}>{error}</Text>}
      <FlatList
        data={error ? [] : tasks}
        keyExtractor={(task) => String(task.id)}
        refreshControl={<RefreshControl refreshing={loading && page <= 1} onRefresh={() => load(1, true)} />}
        // Infinite scroll through mockgen's stable 50-record collection.
        onEndReached={() => !loading && tasks.length < total && load(page + 1)}
        onEndReachedThreshold={0.5}
        ListFooterComponent={loading && page >= 1 ? <ActivityIndicator style={{ margin: 16 }} /> : undefined}
        renderItem={({ item }) => (
          <View style={styles.row}>
            <Image source={{ uri: item.assignee.avatarUrl }} style={styles.avatar} />
            <View style={{ flex: 1 }}>
              <Text style={styles.title}>
                #{item.id} {item.title}
              </Text>
              <Text style={styles.meta}>
                {item.status} · {item.priority} · {item.assignee.firstName} {item.assignee.lastName}
              </Text>
            </View>
          </View>
        )}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, paddingTop: 64, paddingHorizontal: 16, backgroundColor: '#fff' },
  heading: { fontSize: 28, fontWeight: '700', marginBottom: 8 },
  toggle: { fontSize: 16, marginBottom: 12 },
  error: { color: 'crimson', marginBottom: 12 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 10 },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#eee' },
  title: { fontSize: 16 },
  meta: { color: '#666', marginTop: 2 },
});
