/* HO’s Casino — Firebase 설정값
 *
 * README.md 의 「2단계」에서 Firebase 콘솔이 보여 주는 firebaseConfig 값을 아래에 그대로 붙여 넣으세요.
 * (databaseURL 은 「3단계」에서 Realtime Database 를 만든 뒤에 생겨요. 꼭 들어가 있어야 해요.)
 *
 * 이 값들은 비밀번호가 아니에요 — 웹 앱이면 원래 누구나 볼 수 있는 값이고,
 * 보안은 database.rules.json 의 데이터베이스 규칙이 맡아요.
 */
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyB_yDq5_6OPE-xe1VeVDJiCpC7ZXJZo9pU",
  authDomain: "ho-casino.firebaseapp.com",
  // Realtime Database 를 싱가포르(asia-southeast1)에 만들었을 때의 주소.
  // 다른 위치에 만들었다면 콘솔 → Realtime Database → 데이터 탭 맨 위 주소로 바꿔 주세요.
  databaseURL: "https://ho-casino-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "ho-casino",
  storageBucket: "ho-casino.firebasestorage.app",
  messagingSenderId: "694523742488",
  appId: "1:694523742488:web:84b832026fbf771526b66d",
};
