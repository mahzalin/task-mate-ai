
const MODEL = "@cf/google/gemma-4-26b-a4b-it";

function formatPersianDateTime(isoDate) {
  const date = new Date(isoDate);

  const dateText = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "Asia/Tehran"
  }).format(date);

  const timeText = new Intl.DateTimeFormat("fa-IR", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "Asia/Tehran",
    numberingSystem: "latn"
  }).format(date);

  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      hourCycle: "h23",
      timeZone: "Asia/Tehran"
    }).format(date)
  );

  const period = hour < 12 ? "صبح" : "بعدازظهر";

  return {
    dateText,
    timeText,
    period
  };
}

async function sendTelegram(env, method, body) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    }
  );

  const result = await response.json();

  if (!result.ok) {
    console.error("Telegram API error:", result);
  }

  return result;
}

function extractJSON(result) {
  let content =
    result?.response ??
    result?.choices?.[0]?.message?.content ??
    "";

  content = String(content)
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");

  if (start < 0 || end <= start) {
    throw new Error("AI did not return valid JSON");
  }

  return JSON.parse(content.slice(start, end + 1));
}

async function sendDueReminders(env) {
  const result = await env.DB.prepare(`
    SELECT id, telegram_id, title, due_at
    FROM tasks
    WHERE status = 'confirmed'
      AND reminded_at IS NULL
      AND datetime(due_at) <= datetime('now')
    ORDER BY due_at ASC
    LIMIT 50
  `).all();

  for (const task of result.results || []) {
    try {
      const user = await env.DB.prepare(
        "SELECT chat_id FROM users WHERE telegram_id = ?"
      ).bind(task.telegram_id).first();

      if (!user?.chat_id) {
        console.error("No chat ID for task:", task.id);
        continue;
      }

      const formatted = formatPersianDateTime(task.due_at);

      const response = await sendTelegram(env, "sendMessage", {
        chat_id: user.chat_id,
        text:
          `⏰ یادآوری وظیفه\n\n` +
          `📌 وظیفه: ${task.title}\n` +
          `📅 تاریخ: ${formatted.dateText}\n` +
          `🕒 ساعت: ${formatted.timeText} ${formatted.period}\n\n` +
          "آیا این کار را انجام داده‌ای؟",
        reply_markup: {
          inline_keyboard: [[
            {
              text: "✅ انجام شد",
              callback_data: `done:${task.id}`
            }
          ]]
        }
      });

      if (response.ok) {
        await env.DB.prepare(
          `UPDATE tasks
           SET reminded_at = datetime('now')
           WHERE id = ? AND reminded_at IS NULL`
        ).bind(task.id).run();
      } else {
        console.error("Failed to send reminder:", task.id);
      }
    } catch (error) {
      console.error("Reminder error:", task.id, error);
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Yadavar AI Bot is running.");
    }

    if (url.pathname !== "/telegram") {
      return new Response("Not found", { status: 404 });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const secret = request.headers.get(
      "X-Telegram-Bot-Api-Secret-Token"
    );

    if (!env.WEBHOOK_SECRET || secret !== env.WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 403 });
    }

    let update;

    try {
      update = await request.json();
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }

    
    // Handle task confirmation, cancellation, and completion.
    if (update.callback_query) {
      const callback = update.callback_query;
      const data = callback.data || "";
      const match = data.match(/^(confirm|cancel|done):(\d+)$/);

      if (!match) {
        await sendTelegram(env, "answerCallbackQuery", {
          callback_query_id: callback.id,
          text: "عملیات ناشناخته است."
        });
        return new Response("OK");
      }

      const action = match[1];
      const taskId = Number(match[2]);
      const telegramId = String(callback.from.id);

      const expectedStatus =
        action === "done" ? "confirmed" : "pending";

      const task = await env.DB.prepare(
        `SELECT id, title FROM tasks
         WHERE id = ? AND telegram_id = ? AND status = ?`
      ).bind(taskId, telegramId, expectedStatus).first();

      if (!task) {
        await sendTelegram(env, "answerCallbackQuery", {
          callback_query_id: callback.id,
          text: "این وظیفه قبلاً پردازش شده یا پیدا نشد."
        });
        return new Response("OK");
      }

      const newStatus =
        action === "confirm" ? "confirmed" :
        action === "done" ? "done" :
        "cancelled";

      await env.DB.prepare(
        "UPDATE tasks SET status = ? WHERE id = ? AND telegram_id = ?"
      ).bind(newStatus, taskId, telegramId).run();

      await sendTelegram(env, "answerCallbackQuery", {
        callback_query_id: callback.id,
        text:
          action === "confirm" ? "وظیفه تأیید شد." :
          action === "done" ? "وظیفه انجام‌شده ثبت شد." :
          "وظیفه لغو شد."
      });

      const replyText =
        action === "confirm"
          ? `✅ وظیفه ثبت شد:\n${task.title}`
          : action === "done"
            ? `🎉 آفرین! این وظیفه انجام شد:\n${task.title}`
            : `❌ وظیفه لغو شد:\n${task.title}`;

      await sendTelegram(env, "editMessageText", {
        chat_id: callback.message.chat.id,
        message_id: callback.message.message_id,
        text: replyText
      });

      return new Response("OK");
    }


    const message = update.message;

    if (!message?.chat || !message?.from) {
      return new Response("OK");
    }

    const chatId = String(message.chat.id);
    const telegramId = String(message.from.id);
    const text = (message.text || "").trim();

    try {
      await env.DB.prepare(`
        INSERT INTO users (telegram_id, chat_id)
        VALUES (?, ?)
        ON CONFLICT(telegram_id)
        DO UPDATE SET chat_id = excluded.chat_id
      `).bind(telegramId, chatId).run();
    } catch (error) {
      console.error("Database error:", error);
      await sendTelegram(env, "sendMessage", {
        chat_id: chatId,
        text: "خطا در ذخیره اطلاعات کاربر رخ داد. لطفاً دوباره تلاش کن."
      });
      return new Response("OK");
    }

    if (text === "/start") {
      await sendTelegram(env, "sendMessage", {
        chat_id: chatId,
        text:
          "سلام! 👋 من یادآور هوشمند تو هستم.\n\n" +
          "یک کار همراه با زمانش برایم بنویس؛ مثلاً:\n" +
          "«فردا ساعت ۱۰ با دکتر تماس بگیرم»\n\n" +
          "عنوان و زمان را بررسی می‌کنم و قبل از تأیید از تو اجازه می‌گیرم."
      });
      return new Response("OK");
    }

    if (!text || text.startsWith("/")) {
      await sendTelegram(env, "sendMessage", {
        chat_id: chatId,
        text: "لطفاً کار موردنظرت را به زبان طبیعی بنویس."
      });
      return new Response("OK");
    }

    await sendTelegram(env, "sendMessage", {
      chat_id: chatId,
      text: "دارم پیام تو را بررسی می‌کنم…"
    });

    try {
      const now = new Date().toLocaleString("en-CA", {
        timeZone: "Asia/Tehran",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      });

      const aiResult = await env.AI.run(MODEL, {
        messages: [
          {
            role: "system",
            content:
              "You extract task information from Persian messages. " +
              "The current date in Tehran is " + now + ". " +
              "Return ONLY a JSON object with keys: title, due_at, needs_clarification. " +
              "title must be a short Persian task title. " +
              "due_at must be an ISO 8601 datetime with Tehran offset +03:30, " +
              "for example 2026-10-10T10:00:00+03:30. " +
              "Interpret relative dates from the provided current date. " +
              "If no specific date and time can be confidently determined, set due_at to null " +
              "and needs_clarification to true. Never invent a time. " +
              "If the message is not a task, also set needs_clarification to true."
          },
          {
            role: "user",
            content: text
          }
        ],
        chat_template_kwargs: {
          enable_thinking: false
        }
      });

      const task = extractJSON(aiResult);

      if (
        typeof task.title !== "string" ||
        !task.title.trim() ||
        typeof task.due_at !== "string" ||
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+03:30$/.test(task.due_at) ||
        Number.isNaN(Date.parse(task.due_at)) ||
        Date.parse(task.due_at) <= Date.now() ||
        task.needs_clarification === true
      ) {
        await sendTelegram(env, "sendMessage", {
          chat_id: chatId,
          text:
            "برای ثبت وظیفه، تاریخ و ساعت دقیق لازم است.\n" +
            "مثلاً بنویس: «فردا ساعت ۱۰ با دکتر تماس بگیرم»."
        });
        return new Response("OK");
      }

      const inserted = await env.DB.prepare(`
        INSERT INTO tasks (telegram_id, title, due_at, status)
        VALUES (?, ?, ?, 'pending')
      `).bind(telegramId, task.title.trim(), task.due_at).run();

      const taskId = inserted.meta.last_row_id;

      
    const formatted = formatPersianDateTime(task.due_at);

    await sendTelegram(env, "sendMessage", {
      chat_id: chatId,
      text:
        `📌 وظیفه: ${task.title.trim()}\n` +
        `📅 تاریخ: ${formatted.dateText}\n` +
        `🕒 ساعت: ${formatted.timeText} ${formatted.period}\n\n` +
        "آیا این اطلاعات درست است؟",
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ تأیید", callback_data: `confirm:${taskId}` },
          { text: "❌ لغو", callback_data: `cancel:${taskId}` }
        ]]
      }
    });

    } catch (error) {
      console.error("AI/task error:", error);

      await sendTelegram(env, "sendMessage", {
        chat_id: chatId,
        text:
          "نتوانستم پیام را به‌درستی تحلیل کنم. " +
          "لطفاً دوباره با عنوان، تاریخ و ساعت مشخص بنویس."
      });
    }

    return new Response("OK");
  },
  
  async scheduled(controller, env, ctx) {
    await sendDueReminders(env);
  }
};
