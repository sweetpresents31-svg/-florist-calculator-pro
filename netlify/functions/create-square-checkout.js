const crypto = require("crypto");

const SQUARE_API = "https://connect.squareup.com";
const SQUARE_VERSION = "2026-08-19";

function env(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing environment variable: ${name}`);
  }

  return value;
}

exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "POST, OPTIONS"
  };

  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 200,
      headers,
      body: "ok"
    };
  }

  if (event.httpMethod !== "POST") {
    return {
      statusCode: 405,
      headers,
      body: "Method not allowed"
    };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const plan = body.plan;

    if (plan !== "monthly" && plan !== "yearly") {
      return {
        statusCode: 400,
        headers: {
          ...headers,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          error: "Invalid plan"
        })
      };
    }

    const monthly = plan === "monthly";

    const planVariationId = monthly
      ? env("SQUARE_MONTHLY_PLAN_VARIATION_ID")
      : env("SQUARE_YEARLY_PLAN_VARIATION_ID");

    const amount = Number(
      monthly
        ? env("SQUARE_MONTHLY_PRICE_CENTS")
        : env("SQUARE_YEARLY_PRICE_CENTS")
    );

    if (!Number.isInteger(amount) || amount <= 0) {
      throw new Error("Invalid Square subscription price");
    }

    const planName = monthly
      ? "Florist Calculator Pro - Mensual"
      : "Florist Calculator Pro - Anual";

    const requestBody = {
      idempotency_key: crypto.randomUUID(),

      description: planName,

      quick_pay: {
        name: planName,

        price_money: {
          amount,
          currency: "USD"
        },

        location_id: env("SQUARE_LOCATION_ID")
      },

      checkout_options: {
        subscription_plan_id: planVariationId,

        redirect_url: env("FLORIST_CALCULATOR_URL"),

        ask_for_shipping_address: false
      }
    };

    const response = await fetch(
      `${SQUARE_API}/v2/online-checkout/payment-links`,
      {
        method: "POST",

        headers: {
          Authorization: `Bearer ${env("SQUARE_ACCESS_TOKEN")}`,
          "Square-Version": SQUARE_VERSION,
          "Content-Type": "application/json"
        },

        body: JSON.stringify(requestBody)
      }
    );

    const data = await response.json();

    if (!response.ok) {
      console.error("Square checkout error:", data);

      return {
        statusCode: 500,

        headers: {
          ...headers,
          "Content-Type": "application/json"
        },

        body: JSON.stringify({
          error: "Square checkout error",
          details: data
        })
      };
    }

    const checkoutUrl =
      data?.payment_link?.url;

    if (!checkoutUrl) {
      throw new Error(
        "Square did not return a checkout URL"
      );
    }

    return {
      statusCode: 200,

      headers: {
        ...headers,
        "Content-Type": "application/json"
      },

      body: JSON.stringify({
        url: checkoutUrl
      })
    };
  } catch (error) {
    console.error(error);

    return {
      statusCode: 500,

      headers: {
        ...headers,
        "Content-Type": "application/json"
      },

      body: JSON.stringify({
        error: String(error)
      })
    };
  }
};
