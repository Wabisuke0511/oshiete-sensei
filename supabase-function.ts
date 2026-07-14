const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// ====== きょうか（教科）ごとの設定 ======
const SUBJECTS: Record<string, { name: string; guide: string }> = {
  sansu: {
    name: "算数",
    guide: `日本の小学生の算数でよく出る記号・単位を想定してください：□（空欄）、×・÷、あまり、²（平方）、分数、長さ(mm/cm/m/km)、重さ(mg/g/kg/t)、かさ(mL/dL/L/kL)、面積(cm²/m²/a/ha/km²)。
式や計算のとちゅうを、ステップごとにていねいに見せてください。「kotae」には最終的な答えを入れます。`,
  },
  kokugo: {
    name: "国語",
    guide: `漢字の読み書き、言葉の意味、ことわざ・慣用句、文法、そして読解問題などを想定してください。
読解問題では、本文のどこに答えのヒントがあるかを示してあげてください。
答えが一つに決まらない記述問題のときは、「kotae」に模範解答の一例を入れてください。`,
  },
  rika: {
    name: "理科",
    guide: `生き物・植物、天気、水や空気、電気・磁石、光・音、月や星、てこ・ふりこ、もののとけ方 などを想定してください。
「なぜそうなるのか」の理由も、身のまわりの例を使ってやさしく説明してください。
実験や観察の問題では、どこに注目すればよいかをヒントにしてください。`,
  },
  shakai: {
    name: "社会",
    guide: `地理（地図・都道府県・川や山・産業）、歴史（できごと・人物・年号）、公民（くらしのしくみ）、地図記号 などを想定してください。
用語は正確に、でもむずかしい言葉はかみくだいて説明してください。`,
  },
  eigo: {
    name: "英語",
    guide: `小学校の英語を想定してください。単語の意味、あいさつ、かんたんな文、英語→日本語や日本語→英語の言いかえなどです。
ローマ字と英語のちがいに気をつけてください。英単語は正しいつづりで示し、読み方（カタカナ）もそえてあげてください。`,
  },
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS_HEADERS });
  }

  if (req.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "POSTでリクエストしてね" }),
      { status: 405, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  const apiKey = Deno.env.get("ANTHROPIC_API_KEY");
  if (!apiKey) {
    return new Response(
      JSON.stringify({ error: "サーバーの設定に問題があります" }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  let body: { subject?: string; problem_text?: string; image_base64?: string; media_type?: string };
  try {
    body = await req.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "リクエストの形式が正しくありません" }),
      { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  // きょうかを決める（未指定・不明なら算数）
  const subjectKey = body.subject && SUBJECTS[body.subject] ? body.subject : "sansu";
  const subj = SUBJECTS[subjectKey];

  type ContentBlock =
    | { type: "text"; text: string }
    | { type: "image"; source: { type: "base64"; media_type: string; data: string } };

  const userContent: ContentBlock[] = [];

  if (body.image_base64 && body.media_type) {
    userContent.push({
      type: "image",
      source: {
        type: "base64",
        media_type: body.media_type,
        data: body.image_base64,
      },
    });
    userContent.push({ type: "text", text: `この写真の${subj.name}の問題を教えてください。` });
  } else if (body.problem_text) {
    userContent.push({ type: "text", text: body.problem_text });
  } else {
    return new Response(
      JSON.stringify({ error: "problem_text か image_base64 を送ってね" }),
      { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  const systemPrompt = `あなたは、10歳くらいの日本の小学生にやさしく教える「${subj.name}」の家庭教師です。

【この教科について】
${subj.guide}

【写真・文章の読み取りについて】
- まず問題を注意深く、正確に書き写してから考えてください。
- 写真に複数の問題が写っている場合は、いちばん中央で大きく・はっきり写っている1問だけを選んでください。
- どうしても読めない文字は決めつけず、mondai に「（ここが よめませんでした）」のように残してください。
- もし問題が「${subj.name}」ではなく他の教科のように見えても、写っている問題をそのまま教えてあげてください。

【教え方について】
- いきなり答えを言わず、子どもが自分で考えられるように、やさしいヒントを段階的に出します。
- むずかしい言葉は使わず、あたたかく励ます口調で。
- 最後にだけ、答えと解き方（考え方）をていねいに見せてください。

返答は必ず次のJSONだけを返してください。前置きやマークダウンのコードブロック（\`\`\`など）は絶対に付けないでください：
{"mondai":"読み取った問題（記号や式をそのまま）","hints":["ヒント1（いちばんやさしい入口）","ヒント2","ヒント3（もう少しで解ける）"],"kaisetsu":"最後の解き方・考え方をステップごとに、やさしい言葉で","kotae":"答え"}`;

  let anthropicRes: Response;
  try {
    anthropicRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-opus-4-8",
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
      }),
    });
  } catch {
    return new Response(
      JSON.stringify({ error: "AIへの接続でエラーが起きました。しばらくしてからもう一度試してね" }),
      { status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  if (!anthropicRes.ok) {
    return new Response(
      JSON.stringify({ error: "AIがうまく動きませんでした。もう一度試してね" }),
      { status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  const anthropicData = await anthropicRes.json();
  const rawText: string = anthropicData?.content?.[0]?.text ?? "";

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return new Response(
      JSON.stringify({ error: "うまく読み取れませんでした。もう一度、明るいところで撮ってみてね" }),
      { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify(parsed),
    { status: 200, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
  );
});
