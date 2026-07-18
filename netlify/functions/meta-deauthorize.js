// netlify/functions/meta-deauthorize.js

exports.handler = async (event) => {
  try {
    if (event.httpMethod !== "POST") {
      return {
        statusCode: 405,
        body: "Method Not Allowed",
      };
    }

    const body = JSON.parse(event.body || "{}");

    console.log("Meta deauthorize callback received:", JSON.stringify(body, null, 2));

    // Meta may send signed_request or other payload data.
    // Later: use this event to mark the user's Meta integration as disconnected in Supabase.
    // Example future action:
    // - Find integration by Meta user/business ID
    // - Set status = 'disconnected'
    // - Remove access/refresh tokens from database

    return {
      statusCode: 200,
      body: "DEAUTHORIZED_RECEIVED",
    };
  } catch (error) {
    console.error("Meta deauthorize callback error:", error);

    return {
      statusCode: 500,
      body: "Internal Server Error",
    };
  }
};