const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const cors = require("cors");
require("dotenv").config();

const app = express();

// 중요: 서명 검증을 위해 rawBody를 저장하도록 설정
app.use(
  express.json({
    verify: function (req, res, buf) {
      req.rawBody = buf.toString("utf8");
    },
  }),
);
app.use(cors());

const MALL_ID = process.env.CAFE24_MALL_ID;
const CLIENT_ID = process.env.CAFE24_CLIENT_ID;
const CLIENT_SECRET = process.env.CAFE24_CLIENT_SECRET;
const REDIRECT_URI = "/";

// 실제 서비스에서는 Redis나 DB에 저장해야 합니다.
// 현재는 테스트용으로 메모리에 저장합니다. (서버 재시작 시 초기화됨)
let cachedToken = null;

// ============================================================
// 서명 검증 (믹스패널 코드 방식 유지)
// ============================================================
function verifyCafe24Signature(req) {
  const signature = req.headers["x-cafe24-signature"];
  if (!signature) return true;

  const hmac = crypto
    .createHmac("sha256", CLIENT_SECRET)
    .update(req.rawBody || "")
    .digest("base64");

  return hmac === signature;
}

// ============================================================
// OAuth 인증 (토큰 발급)
// ============================================================
app.get("/oauth/callback", async function (req, res) {
  const { code, mall_id } = req.query;
  const targetMall = mall_id || MALL_ID;

  try {
    const tokenResponse = await axios.post(
      `https://${targetMall}.cafe24api.com/api/v2/oauth/token`,
      new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
      }),
      {
        headers: {
          Authorization: `Basic ${Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      },
    );

    // 발급받은 토큰 저장
    cachedToken = tokenResponse.data.access_token;
    console.log("[PF] 토큰 발급 성공!");

    res.send("<h1>✅ 연결 성공! 이제 쿠폰 조회가 가능합니다.</h1>");
  } catch (err) {
    console.error("[PF] 토큰 발급 실패:", err.response?.data || err.message);
    res.status(500).send("인증 실패");
  }
});

// ============================================================
// 쿠폰 조회 API (수정된 핵심 부분)
// ============================================================
app.get("/api/coupons", async (req, res) => {
  const { member_id } = req.query;

  if (!member_id) {
    return res.status(400).json({ error: "member_id가 필요합니다." });
  }

  if (!cachedToken) {
    return res
      .status(401)
      .json({ error: "먼저 앱 설치(/)를 통해 인증을 완료해주세요." });
  }

  try {
    const response = await axios.get(
      `https://${MALL_ID}.cafe24api.com/api/v2/admin/customers/${member_id}/coupons`,
      {
        headers: {
          // 중요: Basic이 아니라 Bearer 토큰을 사용해야 합니다.
          Authorization: `Bearer ${cachedToken}`,
          "Content-Type": "application/json",
          "X-Cafe24-Api-Version": "2024-06-01", // 최신 버전 명시 권장
        },
      },
    );

    res.json({
      success: true,
      coupons: response.data.coupons,
    });
  } catch (e) {
    const errorDetail = e.response?.data || e.message;
    console.error("[PF] 쿠폰 조회 에러:", errorDetail);

    // 토큰이 만료된 경우 401 에러가 발생할 수 있습니다.
    res.status(e.response?.status || 500).json({
      error: "쿠폰 조회 실패",
      detail: errorDetail,
    });
  }
});

app.listen(3000, () => console.log("서버 실행 중 : 3000"));
