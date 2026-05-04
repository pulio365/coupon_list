const express = require('express');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const MALL_ID = process.env.CAFE24_MALL_ID;
const CLIENT_ID = process.env.CAFE24_CLIENT_ID;
const CLIENT_SECRET = process.env.CAFE24_CLIENT_SECRET;

// 카페24 액세스 토큰 발급
async function getAccessToken() {
  const credentials = Buffer.from(`${CLIENT_ID}:${CLIENT_SECRET}`).toString('base64');
  const res = await axios.post(
    `https://${MALL_ID}.cafe24api.com/api/v2/oauth/token`,
    'grant_type=client_credentials&scope=mall.read_customer',
    {
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    }
  );
  return res.data.access_token;
}

// GET /api/coupons?member_id=xxx
app.get('/api/coupons', async (req, res) => {
  const { member_id } = req.query;

  if (!member_id) {
    return res.status(400).json({ error: 'member_id 필요해요' });
  }

  try {
    const token = await getAccessToken();

    const response = await axios.get(
      `https://${MALL_ID}.cafe24api.com/api/v2/admin/customers/${member_id}/coupons`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'X-Cafe24-Api-Version': '2024-06-01',
        },
      }
    );

    // 쿠폰 리스트만 프론트로 전달
    res.json({ coupons: response.data.coupons });

  } catch (e) {
    console.error(e.response?.data || e.message);
    res.status(500).json({ error: '쿠폰 조회 실패' });
  }
});

app.listen(3000, () => console.log('서버 실행 중 :3000'));
