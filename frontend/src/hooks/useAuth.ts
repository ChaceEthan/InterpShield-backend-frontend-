import { useEffect, useRef, useCallback, useState } from 'react';

interface User {
  id: string;
  name: string;
  email: string;
  avatar?: string;
  picture?: string;
  plan: 'free' | 'pro';
  provider: string;
  role?: 'admin' | 'user';
  settings?: Record<string, any>;
}

interface AuthStatus {
  isAuthed: boolean;
  isLoading: boolean;
  user: User | null;
  token: string | null;
  error: string | null;
}

const TOKEN_STORAGE_KEY = 'interp_shield_token';
const USER_STORAGE_KEY = 'interp_shield_user';
const API_URL = import.meta.env.VITE_API_URL?.replace(/\/$/, '');

/**
 * Auth hook with persistent token management and lazy loading
 */
export const useAuth = () => {
  const [status, setStatus] = useState<AuthStatus>({
    isAuthed: false,
    isLoading: true,
    user: null,
    token: null,
    error: null,
  });

  const initRef = useRef(false);
  const refreshTimeoutRef = useRef<number | null>(null);

  // Read stored credentials
  const readStoredCredentials = useCallback(() => {
    const token = sessionStorage.getItem(TOKEN_STORAGE_KEY) || localStorage.getItem(TOKEN_STORAGE_KEY);
    const userJson = sessionStorage.getItem(USER_STORAGE_KEY) || localStorage.getItem(USER_STORAGE_KEY);

    let user: User | null = null;
    if (userJson) {
      try {
        user = JSON.parse(userJson);
      } catch {
        // Invalid JSON
      }
    }

    return { token, user };
  }, []);

  // API request helper
  const apiRequest = useCallback(
    async <T,>(path: string, options: RequestInit = {}, token?: string | null): Promise<T> => {
      if (!API_URL) {
        throw new Error('API URL not configured');
      }

      const response = await fetch(`${API_URL}${path}`, {
        ...options,
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(options.headers || {}),
        },
      });

      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Request failed');
      return data as T;
    },
    []
  );

  // Initialize auth from storage
  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    const { token, user } = readStoredCredentials();

    if (token && user) {
      setStatus({
        isAuthed: true,
        isLoading: false,
        user,
        token,
        error: null,
      });
    } else {
      setStatus((prev) => ({
        ...prev,
        isLoading: false,
      }));
    }
  }, [readStoredCredentials]);

  // Fetch current user
  const refreshUser = useCallback(
    async (activeToken?: string | null) => {
      const tokenToUse = activeToken || status.token;
      if (!tokenToUse) return;

      try {
        const data = await apiRequest<{ user: User }>(
          '/api/auth/me',
          {},
          tokenToUse
        );

        setStatus((prev) => ({
          ...prev,
          user: data.user,
          error: null,
        }));

        localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(data.user));
        return data.user;
      } catch (error) {
        // Token likely invalid
        logout();
        throw error;
      }
    },
    [apiRequest, status.token]
  );

  // Login
  const login = useCallback(
    async (email: string, password: string, rememberMe = true) => {
      setStatus((prev) => ({
        ...prev,
        isLoading: true,
        error: null,
      }));

      try {
        const data = await apiRequest<{ token: string; user: User }>(
          '/api/auth/login',
          {
            method: 'POST',
            body: JSON.stringify({ email, password }),
          }
        );

        const storage = rememberMe ? localStorage : sessionStorage;
        storage.setItem(TOKEN_STORAGE_KEY, data.token);
        storage.setItem(USER_STORAGE_KEY, JSON.stringify(data.user));

        // Clear other storage
        if (rememberMe) sessionStorage.removeItem(TOKEN_STORAGE_KEY);
        else localStorage.removeItem(TOKEN_STORAGE_KEY);

        setStatus({
          isAuthed: true,
          isLoading: false,
          user: data.user,
          token: data.token,
          error: null,
        });

        return data.user;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Login failed';
        setStatus((prev) => ({
          ...prev,
          isLoading: false,
          error: message,
        }));
        throw error;
      }
    },
    [apiRequest]
  );

  // Signup
  const signup = useCallback(
    async (name: string, email: string, password: string, rememberMe = true) => {
      setStatus((prev) => ({
        ...prev,
        isLoading: true,
        error: null,
      }));

      try {
        const data = await apiRequest<{ token: string; user: User }>(
          '/api/auth/signup',
          {
            method: 'POST',
            body: JSON.stringify({ name, email, password }),
          }
        );

        const storage = rememberMe ? localStorage : sessionStorage;
        storage.setItem(TOKEN_STORAGE_KEY, data.token);
        storage.setItem(USER_STORAGE_KEY, JSON.stringify(data.user));

        if (rememberMe) sessionStorage.removeItem(TOKEN_STORAGE_KEY);
        else localStorage.removeItem(TOKEN_STORAGE_KEY);

        setStatus({
          isAuthed: true,
          isLoading: false,
          user: data.user,
          token: data.token,
          error: null,
        });

        return data.user;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Signup failed';
        setStatus((prev) => ({
          ...prev,
          isLoading: false,
          error: message,
        }));
        throw error;
      }
    },
    [apiRequest]
  );

  // Google OAuth
  const googleSignIn = useCallback(
    async (credential: string, rememberMe = true) => {
      setStatus((prev) => ({
        ...prev,
        isLoading: true,
        error: null,
      }));

      try {
        const data = await apiRequest<{ token: string; user: User }>(
          '/api/auth/google',
          {
            method: 'POST',
            body: JSON.stringify({ credential }),
          }
        );

        const storage = rememberMe ? localStorage : sessionStorage;
        storage.setItem(TOKEN_STORAGE_KEY, data.token);
        storage.setItem(USER_STORAGE_KEY, JSON.stringify(data.user));

        if (rememberMe) sessionStorage.removeItem(TOKEN_STORAGE_KEY);
        else localStorage.removeItem(TOKEN_STORAGE_KEY);

        setStatus({
          isAuthed: true,
          isLoading: false,
          user: data.user,
          token: data.token,
          error: null,
        });

        return data.user;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Google sign-in failed';
        setStatus((prev) => ({
          ...prev,
          isLoading: false,
          error: message,
        }));
        throw error;
      }
    },
    [apiRequest]
  );

  // Logout
  const logout = useCallback(() => {
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
    sessionStorage.removeItem(USER_STORAGE_KEY);
    localStorage.removeItem(TOKEN_STORAGE_KEY);
    localStorage.removeItem(USER_STORAGE_KEY);

    setStatus({
      isAuthed: false,
      isLoading: false,
      user: null,
      token: null,
      error: null,
    });
  }, []);

  // Update user settings
  const updateSettings = useCallback(
    async (settings: Record<string, any>) => {
      if (!status.token) throw new Error('Not authenticated');

      try {
        const data = await apiRequest<{ user: User }>(
          '/api/user/settings',
          {
            method: 'PATCH',
            body: JSON.stringify(settings),
          },
          status.token
        );

        setStatus((prev) => ({
          ...prev,
          user: data.user,
        }));

        localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(data.user));
        return data.user;
      } catch (error) {
        throw error;
      }
    },
    [apiRequest, status.token]
  );

  // Cleanup
  useEffect(() => {
    return () => {
      if (refreshTimeoutRef.current) clearTimeout(refreshTimeoutRef.current);
    };
  }, []);

  return {
    ...status,
    login,
    signup,
    googleSignIn,
    logout,
    refreshUser,
    updateSettings,
  };
};
