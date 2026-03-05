export class ApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
  }
}

interface ApiErrorBody {
  error?: string;
}

async function request<T>(path: string, init: RequestInit = {}, token?: string): Promise<T> {
  const headers = new Headers(init.headers);

  if (!headers.has("Content-Type") && init.body) {
    headers.set("Content-Type", "application/json");
  }

  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const response = await fetch(path, {
    ...init,
    headers,
  });

  const raw = await response.text();
  const parsed = raw ? (JSON.parse(raw) as unknown) : undefined;

  if (!response.ok) {
    const apiError = (parsed as ApiErrorBody | undefined)?.error;
    throw new ApiError(apiError ?? `Request failed with ${response.status}`, response.status);
  }

  return parsed as T;
}

export async function apiGet<T>(path: string, token?: string): Promise<T> {
  return request<T>(path, { method: "GET" }, token);
}

export async function apiPost<T>(path: string, body: unknown, token?: string): Promise<T> {
  return request<T>(
    path,
    {
      method: "POST",
      body: JSON.stringify(body),
    },
    token,
  );
}
