const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const cors = require("cors");
require("dotenv").config();

const app = express();
app.use(cors());
app.use(express.json());

const MALL_ID = process.env.CAFE24_MALL_ID;
const CLIENT_ID = process.env.CAFE24_CLIENT_ID;
const CLIENT_SECRET = process.env.CAFE24_CLIENT_SECRET;

// ============================================================
// 서명 검증
// ============================================================
function verifyCafe24Signature(req) {
  const signature = req.headers["x-cafe24-signature"];
  if (!signature) {
    console.warn("[PF] 서명 헤더 없음 - 통과");
    return true;
  }
  if (!CLIENT_SECRET) {
    console.warn("[PF] CLIENT_SECRET 미설정 - 스킵");
    return true;
  }

  const hmac1 = crypto
    .createHmac("sha256", CLIENT_SECRET)
    .update(req.rawBody)
    .digest("base64");
  if (hmac1 === signature) {
    console.log("[PF] 서명 검증 성공 (방법1)");
    return true;
  }

  try {
    const decoded = Buffer.from(CLIENT_SECRET, "base64").toString("utf8");
    const hmac2 = crypto
      .createHmac("sha256", decoded)
      .update(req.rawBody)
      .digest("base64");
    if (hmac2 === signature) {
      console.log("[PF] 서명 검증 성공 (방법2)");
      return true;
    }
  } catch (e) {}

  try {
    const hmac3 = crypto
      .createHmac("sha256", CLIENT_SECRET)
      .update(JSON.stringify(req.body))
      .digest("base64");
    if (hmac3 === signature) {
      console.log("[PF] 서명 검증 성공 (방법3)");
      return true;
    }
  } catch (e) {}

  console.warn("[PF] 서명 검증 실패 - 수신:", signature);
  const hmacDebug = crypto
    .createHmac("sha256", CLIENT_SECRET)
    .update(req.rawBody)
    .digest("base64");
  console.warn("[PF] 계산:", hmacDebug);
  return true; // 확인 완료 후 false로 변경
}

app.get("/oauth/callback", function (req, res) {
  handleOAuthCallback(req, res);
});

async function handleOAuthCallback(req, res) {
  const { code, error, error_description, mall_id } = req.query;
  const mallId = mall_id || MALL_ID;

  if (error) return res.status(400).send(`설치 오류: ${error_description}`);
  if (!code) return res.status(400).send("인증 코드가 없습니다.");

  try {
    const tokenResponse = await axios.post(
      `https://${mallId}.cafe24api.com/api/v2/oauth/token`,
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
    console.log("[PF] 앱 설치 완료:", mallId, tokenResponse.data.access_token);
    res.send(`<html><body style="font-family:sans-serif;text-align:center;padding:50px;">
            <h1>✅ 앱 설치 완료!</h1><p>쇼핑몰 <strong>${mallId}</strong>에 연결되었습니다.</p>
        </body></html>`);
  } catch (err) {
    const errData = err.response ? err.response.data : err.message;
    console.error("[PF] 토큰 발급 실패:", JSON.stringify(errData));
    res
      .status(500)
      .send(`<h1>❌ 설치 실패</h1><p>${JSON.stringify(errData)}</p>`);
  }
}

// GET /api/coupons?member_id=xxx
app.get("/api/coupons", async (req, res) => {
  const { member_id } = req.query;

  if (!member_id) {
    return res.status(400).json({ error: "member_id 필요해요" });
  }

  try {
    const response = await axios.get(
      `https://${MALL_ID}.cafe24api.com/api/v2/admin/customers/${member_id}/coupons`,
      {
        headers: {
          Authorization: `Basic ${Buffer.from(CLIENT_ID + ":" + CLIENT_SECRET).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
      },
    );

    // 쿠폰 리스트만 프론트로 전달
    res.json({ coupons: response.data.coupons });
  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).json({ error: "쿠폰 조회 실패" });
  }
});

app.listen(3000, () => console.log("서버 실행 중 :3000"));
