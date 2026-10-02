"use server";

import { redirect } from "next/navigation";

import { createSession, destroySession, isValidUsername } from "@/lib/session";

export interface LoginState {
  username?: string;
  error?: string;
}

export async function login(_previous: LoginState, formData: FormData): Promise<LoginState> {
  const username = String(formData.get("username") ?? "").trim();
  if (!isValidUsername(username)) {
    return {
      username,
      error: "Ce nom ne convient pas : de 1 à 64 caractères, lettres sans accent, chiffres, point, tiret, tiret bas ou @.",
    };
  }
  await createSession(username);
  redirect("/");
}

export async function logout(): Promise<void> {
  await destroySession();
  redirect("/login");
}
