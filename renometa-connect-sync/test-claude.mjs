const res = await fetch("https://api.anthropic.com/v1/messages", {

  method: "POST",

  headers: {

    "Content-Type": "application/json",

    "x-api-key": process.env.ANTHROPIC_API_KEY,

    "anthropic-version": "2023-06-01",

  },

  body: JSON.stringify({

    model: "claude-haiku-4-5",

    max_tokens: 100,

    messages: [{ role: "user", content: "Say hello" }],

  }),

});

const data = await res.json();

console.log(JSON.stringify(data, null, 2));
