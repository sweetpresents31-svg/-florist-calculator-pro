const crypto = require("crypto");

const SQUARE_API = "https://connect.squareup.com";
const SQUARE_VERSION = "2026-08-19";

function env(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function verifySquareSignature(rawBody, signature) {
  if (!signature) return false;

  const signatureKey = env("SQUARE_WEBHOOK_SIGNATURE_KEY");
  const notificationUrl = env("SQUARE_WEBHOOK_NOTIFICATION_URL");

  const hmac = crypto.createHmac("sha256", signatureKey);
  hmac.update(notificationUrl + rawBody);

  const expected = hmac.digest("base64");

  const a = Buffer.from(expected);
  const b = Buffer.from(signature);

  if (a.length !== b.length) return false;

  return crypto.timingSafeEqual(a, b);
}

async function squareGet(path) {
  const response = await fetch(`${SQUARE_API}${path}`, {
    headers: {
      Authorization: `Bearer ${env("SQUARE_ACCESS_TOKEN")}`,
      "Square-Version": SQUARE_VERSION,
      "Content-Type": "application/json"
    }
  });

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Square ${response.status}: ${text}`);
  }

  return text ? JSON.parse(text) : {};
}

function supabaseHeaders() {
  const key = env("SUPABASE_SERVICE_ROLE_KEY");

  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    "Content-Type": "application/json",
    Prefer: "return=representation"
  };
}

async function supabaseGet(path) {
  const response = await fetch(
    `${env("SUPABASE_URL")}/rest/v1/${path}`,
    {
      headers: supabaseHeaders()
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Supabase ${response.status}: ${text}`);
  }

  return text ? JSON.parse(text) : null;
}

async function supabaseUpsert(table, payload, conflictColumn) {
  const response = await fetch(
    `${env("SUPABASE_URL")}/rest/v1/${table}?on_conflict=${encodeURIComponent(conflictColumn)}`,
    {
      method: "POST",
      headers: {
        ...supabaseHeaders(),
        Prefer: "resolution=merge-duplicates,return=representation"
      },
      body: JSON.stringify(payload)
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Supabase ${response.status}: ${text}`);
  }

  return text ? JSON.parse(text) : null;
}

async function supabasePatch(table, query, payload) {
  const response = await fetch(
    `${env("SUPABASE_URL")}/rest/v1/${table}?${query}`,
    {
      method: "PATCH",
      headers: supabaseHeaders(),
      body: JSON.stringify(payload)
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Supabase ${response.status}: ${text}`);
  }

  return text ? JSON.parse(text) : null;
}

async function supabaseRpc(functionName, payload) {
  const response = await fetch(
    `${env("SUPABASE_URL")}/rest/v1/rpc/${functionName}`,
    {
      method: "POST",
      headers: supabaseHeaders(),
      body: JSON.stringify(payload)
    }
  );

  const text = await response.text();

  if (!response.ok) {
    throw new Error(`Supabase RPC ${response.status}: ${text}`);
  }

  return text ? JSON.parse(text) : null;
}

function planFromVariation(planVariationId) {
  if (
    planVariationId === env("SQUARE_MONTHLY_PLAN_VARIATION_ID")
  ) {
    return "monthly";
  }

  if (
    planVariationId === env("SQUARE_YEARLY_PLAN_VARIATION_ID")
  ) {
    return "yearly";
  }

  throw new Error(
    `Unknown Square plan variation: ${planVariationId}`
  );
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      body: "Method not allowed"
    };
  }

  const rawBody = event.body || "";

  const signature =
    event.headers["x-square-hmacsha256-signature"] ||
    event.headers["X-Square-Hmacsha256-Signature"];

  try {
    if (!verifySquareSignature(rawBody, signature)) {
      return {
        statusCode: 403,
        body: "Invalid Square signature"
      };
    }

    const payload = JSON.parse(rawBody);

    const eventId = payload.event_id;
    const eventType = payload.type;

    if (!eventId || !eventType) {
      return {
        statusCode: 400,
        body: "Invalid Square event"
      };
    }

    const existing = await supabaseGet(
      `square_webhook_events?event_id=eq.${encodeURIComponent(
        eventId
      )}&select=event_id,status`
    );

    if (
      Array.isArray(existing) &&
      existing[0]?.status === "processed"
    ) {
      return {
        statusCode: 200,
        body: "Already processed"
      };
    }

    await supabaseUpsert(
      "square_webhook_events",
      {
        event_id: eventId,
        event_type: eventType,
        status: "received"
      },
      "event_id"
    );

    if (eventType === "invoice.payment_made") {
      const invoice =
        payload?.data?.object?.invoice;

      const subscriptionId =
        invoice?.subscription_id;

      if (subscriptionId) {
        const subscriptionResponse =
          await squareGet(
            `/v2/subscriptions/${encodeURIComponent(
              subscriptionId
            )}`
          );

        const subscription =
          subscriptionResponse.subscription;

        if (!subscription) {
          throw new Error("Subscription not found");
        }

        const customerId =
          subscription.customer_id;

        const planVariationId =
          subscription.plan_variation_id;

        const plan =
          planFromVariation(planVariationId);

        const customerResponse =
          await squareGet(
            `/v2/customers/${encodeURIComponent(
              customerId
            )}`
          );

        const customer =
          customerResponse.customer;

        const email =
          customer?.email_address;

        if (!email) {
          throw new Error(
            `Square customer ${customerId} has no email`
          );
        }

        const customerName =
          [
            customer?.given_name,
            customer?.family_name
          ]
            .filter(Boolean)
            .join(" ") ||
          customer?.company_name ||
          null;

        const paidAt =
          payload.created_at ||
          new Date().toISOString();

        await supabaseRpc(
          "apply_square_subscription_payment",
          {
            p_email: email,
            p_customer_name: customerName,
            p_plan: plan,
            p_square_customer_id: customerId,
            p_square_subscription_id:
              subscriptionId,
            p_square_plan_variation_id:
              planVariationId,
            p_square_event_id: eventId,
            p_paid_at: paidAt
          }
        );
      }
    }

    if (eventType === "subscription.updated") {
      const subscription =
        payload?.data?.object?.subscription;

      if (subscription?.id) {
        await supabasePatch(
          "florist_licenses",
          `square_subscription_id=eq.${encodeURIComponent(
            subscription.id
          )}`,
          {
            square_status:
              subscription.status,
            updated_at:
              new Date().toISOString()
          }
        );
      }
    }

    if (
      eventType ===
      "invoice.scheduled_charge_failed"
    ) {
      const invoice =
        payload?.data?.object?.invoice;

      const subscriptionId =
        invoice?.subscription_id;

      if (subscriptionId) {
        await supabasePatch(
          "florist_licenses",
          `square_subscription_id=eq.${encodeURIComponent(
            subscriptionId
          )}`,
          {
            square_status:
              "PAYMENT_FAILED",
            updated_at:
              new Date().toISOString()
          }
        );
      }
    }

    await supabasePatch(
      "square_webhook_events",
      `event_id=eq.${encodeURIComponent(
        eventId
      )}`,
      {
        status: "processed",
        processed_at:
          new Date().toISOString(),
        error_message: null
      }
    );

    return {
      statusCode: 200,
      body: "OK"
    };
  } catch (error) {
    console.error(error);

    try {
      const payload = JSON.parse(rawBody);

      if (payload?.event_id) {
        await supabasePatch(
          "square_webhook_events",
          `event_id=eq.${encodeURIComponent(
            payload.event_id
          )}`,
          {
            status: "error",
            error_message: String(error)
          }
        );
      }
    } catch (_) {}

    return {
      statusCode: 500,
      body: "Processing error"
    };
  }
};
