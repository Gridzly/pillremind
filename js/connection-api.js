
import { auth } from "./firebaseConfig.js";

export const CONNECTION_API_URL =
  "https://medminder-connection-api.alyson-samson.workers.dev";

export async function callConnectionApi(action, payload = {}) {
  const user = auth.currentUser;

  if (!user) {
    throw new Error("Please sign in again.");
  }

  if (!CONNECTION_API_URL.startsWith("https://")) {
    throw new Error("Invalid connection service URL.");
  }

  try {
    const idToken = await user.getIdToken();

    const response = await fetch(CONNECTION_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${idToken}`
      },
      body: JSON.stringify({
        action,
        ...payload
      })
    });

    const responseText = await response.text();

    let result = {};

    try {
      result = responseText ? JSON.parse(responseText) : {};
    } catch {
      console.error("Worker returned a non-JSON response:", responseText);
    }

    if (!response.ok || result.success !== true) {
      console.error("Medminder connection API error:", {
        status: response.status,
        response: result
      });

      const error = new Error(
        result.error ||
        `Connection service failed (HTTP ${response.status}).`
      );

      error.status = response.status;
      throw error;
    }

    return result.data;

  } catch (error) {
    console.error("Connection API request failed:", error);
    throw error;
  }
}
