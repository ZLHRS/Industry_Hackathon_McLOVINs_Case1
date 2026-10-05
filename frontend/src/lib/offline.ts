/** Private actor-scoped snapshots and durable, version-preserving executor commands. */
export type ActionRequest = {
  action: string;
  expected_version: number;
  [key: string]: unknown;
};
export type PendingAction = {
  id: string;
  actorId: string;
  orderId: string;
  request: ActionRequest;
  createdAt: string;
  attempts: number;
  state: "pending" | "blocked";
  error?: string;
};
export type SyncReport = {
  sent: number;
  blocked: number;
  remaining: number;
  offline: boolean;
  unauthorized: boolean;
};
type Snapshot<T> = { actorId: string; key: string; savedAt: string; data: T };
type Sender = (entry: PendingAction) => Promise<unknown>;
const DATABASE = "naryadai-private-v1";
const MAX_CACHE_AGE = 8 * 60 * 60 * 1000;
const allowedActions = new Set(["accept", "queue", "reject", "start", "pause", "resume", "complete"]);
let connection: Promise<IDBDatabase> | undefined;
const running = new Map<string, Promise<SyncReport>>();

export class OfflineStorageError extends Error {
  constructor(
    message = "Локальное хранилище недоступно. Освободите место или используйте обычный режим браузера.",
  ) {
    super(message);
    this.name = "OfflineStorageError";
  }
}

function openDatabase(): Promise<IDBDatabase> {
  if (!connection) {
    connection = new Promise<IDBDatabase>((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new OfflineStorageError());
        return;
      }
      const request = indexedDB.open(DATABASE, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        const cache = db.createObjectStore("snapshots", { keyPath: ["actorId", "key"] });
        cache.createIndex("actor", "actorId");
        const queue = db.createObjectStore("pending", { keyPath: ["actorId", "id"] });
        queue.createIndex("actor", "actorId");
        queue.createIndex("order", ["actorId", "orderId"], { unique: true });
      };
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => {
          db.close();
          connection = undefined;
        };
        resolve(db);
      };
      request.onerror = () => reject(new OfflineStorageError());
      request.onblocked = () =>
        reject(new OfflineStorageError("Закройте другие вкладки приложения и повторите."));
    }).catch((error: unknown) => {
      connection = undefined;
      throw error;
    });
  }
  return connection;
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new OfflineStorageError());
  });
}

async function transaction<T>(
  stores: string | string[],
  mode: IDBTransactionMode,
  perform: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  const db = await openDatabase();
  const tx = db.transaction(stores, mode);
  const completed = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new OfflineStorageError());
    tx.onerror = () => reject(tx.error ?? new OfflineStorageError());
  });
  // Register both outcomes before awaiting requests: a failed request also aborts its transaction.
  const result = await Promise.all([perform(tx), completed]);
  return result[0];
}

export async function saveSnapshot<T>(actorId: string, key: string, data: T): Promise<void> {
  if (!actorId || !key) throw new OfflineStorageError("Не указан владелец локальных данных.");
  await transaction("snapshots", "readwrite", async (tx) => {
    await requestValue(
      tx.objectStore("snapshots").put({ actorId, key, data, savedAt: new Date().toISOString() }),
    );
  });
}

export async function getSnapshot<T>(
  actorId: string,
  key: string,
): Promise<{ data: T; savedAt: string } | null> {
  return transaction("snapshots", "readwrite", async (tx) => {
    const store = tx.objectStore("snapshots");
    const entry = await requestValue<Snapshot<T> | undefined>(store.get([actorId, key]));
    if (!entry) return null;
    const age = Date.now() - Date.parse(entry.savedAt);
    if (!Number.isFinite(age) || age < 0 || age > MAX_CACHE_AGE) {
      await requestValue(store.delete([actorId, key]));
      return null;
    }
    return { data: entry.data, savedAt: entry.savedAt };
  });
}

export async function listPending(actorId: string): Promise<PendingAction[]> {
  const entries = await transaction("pending", "readonly", (tx) =>
    requestValue<PendingAction[]>(tx.objectStore("pending").index("actor").getAll(actorId)),
  );
  return entries.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export async function enqueue(input: {
  actorId: string;
  orderId: string;
  request: ActionRequest;
}): Promise<PendingAction> {
  if (
    !input.actorId ||
    !input.orderId ||
    !allowedActions.has(input.request.action) ||
    !Number.isSafeInteger(input.request.expected_version) ||
    input.request.expected_version < 1
  ) {
    throw new OfflineStorageError("Это действие нельзя сохранить для отправки без связи.");
  }
  const entry: PendingAction = {
    ...input,
    request: structuredClone(input.request),
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    attempts: 0,
    state: "pending",
  };
  try {
    await transaction("pending", "readwrite", async (tx) => {
      await requestValue(tx.objectStore("pending").add(entry));
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === "ConstraintError") {
      throw new OfflineStorageError(
        "По этому наряду уже ожидается отправка. Сначала отправьте или удалите предыдущее действие.",
      );
    }
    throw new OfflineStorageError();
  }
  return entry;
}

export async function removePending(actorId: string, id: string): Promise<void> {
  await transaction("pending", "readwrite", async (tx) => {
    await requestValue(tx.objectStore("pending").delete([actorId, id]));
  });
}

/** Logout invalidates all cached snapshots and unsent actions for this actor. */
export async function clearActor(actorId: string): Promise<void> {
  await transaction(["snapshots", "pending"], "readwrite", async (tx) => {
    for (const name of ["snapshots", "pending"]) {
      const store = tx.objectStore(name);
      const keys = await requestValue(store.index("actor").getAllKeys(actorId));
      for (const key of keys) await requestValue(store.delete(key));
    }
  });
}

function errorStatus(error: unknown): number | undefined {
  if (typeof error === "object" && error !== null && "status" in error && typeof error.status === "number") {
    return error.status;
  }
  return undefined;
}

async function updateExisting(entry: PendingAction): Promise<void> {
  // A concurrent logout/delete must not resurrect private data after an in-flight request.
  await transaction("pending", "readwrite", async (tx) => {
    const store = tx.objectStore("pending");
    if (await requestValue(store.get([entry.actorId, entry.id]))) await requestValue(store.put(entry));
  });
}

async function sendQueue(actorId: string, send: Sender, onlyId?: string): Promise<SyncReport> {
  const report: SyncReport = { sent: 0, blocked: 0, remaining: 0, offline: false, unauthorized: false };
  const entries = await listPending(actorId);
  for (const original of entries) {
    if (onlyId ? original.id !== onlyId : original.state === "blocked") continue;
    // An action removed in another tab, including by logout, must not be sent later.
    const current = await transaction("pending", "readonly", (tx) =>
      requestValue<PendingAction | undefined>(tx.objectStore("pending").get([actorId, original.id])),
    );
    if (!current) continue;
    const entry = { ...current, attempts: current.attempts + 1 };
    try {
      await send(structuredClone(entry));
      await removePending(actorId, entry.id);
      report.sent += 1;
    } catch (error) {
      const status = errorStatus(error);
      if (status === 401) {
        report.unauthorized = true;
        break;
      }
      if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) {
        entry.state = "blocked";
        entry.error =
          status === 409
            ? "Наряд изменился. Откройте актуальную карточку; удалите это действие и повторите осознанно."
            : "Сервер отклонил действие. Проверьте права и актуальную карточку перед повтором.";
        report.blocked += 1;
        await updateExisting(entry);
        continue;
      }
      entry.state = "pending";
      entry.error = "Действие пока не подтверждено сервером. Повтор сохранит исходный ключ и версию.";
      await updateExisting(entry);
      report.offline = true;
      break;
    }
  }
  report.remaining = (await listPending(actorId)).length;
  return report;
}

function coordinatedSync(actorId: string, send: Sender, onlyId?: string): Promise<SyncReport> {
  const existing = running.get(actorId);
  if (existing) return existing;
  const execute = () => sendQueue(actorId, send, onlyId);
  const task =
    typeof navigator !== "undefined" && navigator.locks
      ? navigator.locks.request(`naryadai-sync-${actorId}`, execute)
      : execute();
  running.set(actorId, task);
  void task
    .finally(() => {
      if (running.get(actorId) === task) running.delete(actorId);
    })
    .catch(() => undefined);
  return task;
}

export function syncPending(actorId: string, send: Sender): Promise<SyncReport> {
  return coordinatedSync(actorId, send);
}

/** Retries exactly the original command. Never changes the expected version or payload. */
export function retryPending(actorId: string, id: string, send: Sender): Promise<SyncReport> {
  return coordinatedSync(actorId, send, id);
}
