﻿const config = require("config.json");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const sendEmail = require("_helpers/send-email");
const db = require("_helpers/db");
const Role = require("_helpers/role");
const axios = require("axios");
const fetch = require("node-fetch");
const Roles = require("../_helpers/role");
const chatHandler = require("../chat/chat.handler");

const {
  changeChatUserPassword,
  synchronizedChatUser,
  updateChatUser,
  authenticateChatAccessToken,
} = chatHandler;

module.exports = {
  authenticate,
  refreshToken,
  revokeToken,
  register,
  registerWithoutSynchronizeChat,
  verifyEmail,
  forgotPassword,
  validateResetToken,
  resetPassword,
  getAll,
  getById,
  create,
  update,
  delete: _delete,
  authorization,
  submitDeviceToken,
  testNotification,
  authenticateChatUser,
  rawSubmitDeviceToken,
};

async function authenticate({
  username,
  password,
  ipAddress,
  isSynchroChatUser,
}) {
  const res = await axios.post("https://o2oviet.com/user-check-register.php", {
      username,
      password,
    }),
    { data } = res;

  if (res.status === 200) {
    const {
      username,
      email,
      first_name,
      last_name,
      //   password,
      phone_number,
    } = data;
    console.log("DATA", data);
    const existAccount = {};
    existAccount.username = username;
    existAccount.firstName = data.first_name;
    existAccount.lastName = data.last_name;
    existAccount.email = data.email;
    existAccount.passwordHash = hash(password);
    existAccount.phoneNumber = data.phone_number;
    existAccount.avatar = data.avatar;
    existAccount.cover = data.cover;
    existAccount.userId = data.user_id;
    existAccount.userPassword = data.password;
    existAccount.background_image = data.background_image;
    existAccount.address = data.address;
    existAccount.working = data.working;
    existAccount.working_link = data.working_link;
    existAccount.about = data.about;
    existAccount.school = data.school;
    existAccount.gender = data.gender;
    existAccount.birthday = data.birthday;
    existAccount.language = data.language;
    existAccount.role = Role.User;
    await db.Account.update({ username }, existAccount, { upsert: true });
    const chatRegister = isSynchroChatUser
      ? await synchronizedChatUser({
          username,
          email,
          firstName: first_name,
          lastName: last_name,
          password,
          phone: phone_number,
        }).catch((error) => {
          console.log("synchronize chat fail", error);
        })
      : null;
    const account = await db.Account.findOne({ username });

    if (!account || !bcrypt.compareSync(password, account.passwordHash)) {
      throw "Username or password is incorrect";
    }

    const token = generateJwtToken(account);
    const refreshToken = generateRefreshToken(account, ipAddress);
    account.token = token;
    let chat_access_token = "";
    let chat_user_id = "";
    if (chatRegister && chatRegister.data && chatRegister.data.access_token) {
      account.chat_access_token = chatRegister.data.access_token;
      chat_access_token = chatRegister.data.access_token;
      chat_user_id = chatRegister.data._id;
    }
    await account.save();
    await refreshToken.save();
    const result = {
      ...basicDetails(account),
      token,
      refreshToken: refreshToken.token,
      chat_user_id,
    };
    if (chat_access_token) {
      result.chat_access_token = chat_access_token;
    }
    return result;
  } else {
    throw "Username or password is incorrect";
  }
}

async function refreshToken({ token, ipAddress }) {
  const refreshToken = await getRefreshToken(token);
  const { account } = refreshToken;

  // replace old refresh token with a new one and save
  const newRefreshToken = generateRefreshToken(account, ipAddress);
  refreshToken.revoked = Date.now();
  refreshToken.revokedByIp = ipAddress;
  refreshToken.replacedByToken = newRefreshToken.token;
  await refreshToken.save();
  await newRefreshToken.save();

  // generate new jwt
  const jwtToken = generateJwtToken(account);

  await db.Account.update({ _id: account._id }, { token: jwtToken });

  // return basic details and tokens
  return {
    ...basicDetails(account),
    jwtToken,
    refreshToken: newRefreshToken.token,
  };
}

async function revokeToken({ token, ipAddress }) {
  const refreshToken = await getRefreshToken(token);

  // revoke token and save
  refreshToken.revoked = Date.now();
  refreshToken.revokedByIp = ipAddress;
  await refreshToken.save();
}

async function register(params, origin) {
  let { isSynchroChatUser, ...other } = params;

  params = other;
  const {
    username,
    password,
    firstName,
    lastName,
    phoneNumber,
    email,
  } = params;

  const data = await (
    await fetch("https://o2oviet.com/user.php", {
      method: "POST",
      body: JSON.stringify({
        username: params.username,
        password: params.password,
        email: params.email,
        first_name: params.firstName,
        last_name: params.lastName,
        phone_number: params.phoneNumber,
        gender: params.gender,
      }),
      headers: { "Content-Type": "application/json" },
    })
  ).json();

  if (data.message === "Email or username was used!") {
    throw "Email or tên đăng nhập đã được sử dụng!";
  }
  const user = await db.Account.findOne({ username: params.username });
  if (user) {
    // send already registered error in email to prevent account enumeration
    // const tempUser = await db.Account.findOne({ username: params.username });
    if (isSynchroChatUser) {
      await synchronizedChatUser({
        username: params.username,
        email: params.email,
        firstName: params.firstName,
        lastName: params.lastName,
        password: params.password,
        phone: phoneNumber,
      }).catch((error) => {
        console.log("synchronize chat when register", error);
      });
    }
    return await sendAlreadyRegisteredEmail(user.email, origin);
  }

  // create account object
  const account = new db.Account(params);

  account.avatar = data.avatar;
  account.cover = data.cover;
  account.userId = data.user_id;
  account.userPassword = data.password;
  account.background_image = data.background_image;
  account.address = data.address;
  account.working = data.working;
  account.working_link = data.working_link;
  account.about = data.about;
  account.school = data.school;
  account.gender = data.gender;
  account.birthday = data.birthday;
  account.language = data.language;
  // first registered account is an admin
  account.role = Role.User;
  account.verificationToken = randomTokenString();

  // hash password
  account.passwordHash = hash(params.password);

  // save account
  await account.save();

  if (isSynchroChatUser) {
    const chatUser = await synchronizedChatUser({
      username,
      email,
      firstName,
      lastName,
      password,
      phone: phoneNumber,
    }).catch((error) => {
      console.log("synchronize chat when register", error);
    });
  }

  // send email
  await sendVerificationEmail(account, origin);
  // .then(res => res.json())
  //     .then(async data => {

  //     })
  //     .catch(err => {
  //         throw err
  //     })
}

async function registerWithoutSynchronizeChat(params, origin) {
  const data = await (
    await fetch("https://o2oviet.com/user.php", {
      method: "POST",
      body: JSON.stringify({
        username: params.username,
        password: params.password,
        email: params.email,
        first_name: params.firstName,
        last_name: params.lastName,
        phone_number: params.phoneNumber,
        gender: params.gender,
      }),
      headers: { "Content-Type": "application/json" },
    })
  ).json();

  if (data.message === "Email or username was used!") {
    throw "Email or tên đăng nhập đã được sử dụng!";
  }
  const user = await db.Account.findOne({ username: params.username });
  if (user) {
    // send already registered error in email to prevent account enumeration
    // const tempUser = await db.Account.findOne({ username: params.username });
    return await sendAlreadyRegisteredEmail(user.email, origin);
  }

  // create account object
  const account = new db.Account(params);

  account.avatar = data.avatar;
  account.cover = data.cover;
  account.userId = data.user_id;
  account.userPassword = data.password;
  account.background_image = data.background_image;
  account.address = data.address;
  account.working = data.working;
  account.working_link = data.working_link;
  account.about = data.about;
  account.school = data.school;
  account.gender = data.gender;
  account.birthday = data.birthday;
  account.language = data.language;
  // first registered account is an admin
  account.role = Role.User;
  account.verificationToken = randomTokenString();

  // hash password
  account.passwordHash = hash(params.password);

  // save account
  await account.save();

  // send email
  await sendVerificationEmail(account, origin);
}

async function verifyEmail({ token }) {
  const account = await db.Account.findOne({ verificationToken: token });
  if (!account) throw "Verification failed";

  account.verified = Date.now();
  account.verificationToken = undefined;
  const tempToken = generateJwtToken(account);
  const res = await (
    await fetch("https://o2oviet.com/user-active.php", {
      method: "POST",
      body: JSON.stringify({}),
      headers: {
        "Content-Type": "application/json",
        Authorization: tempToken,
      },
    })
  ).json();
  if (res.message == "Success") {
    await account.save();
  } else {
    throw "Không thể xác thực";
  }
}

async function forgotPassword({ email }, origin) {
  const account = await db.Account.findOne({ email });

  // always return ok response to prevent email enumeration
  if (!account) return;

  // create reset token that expires after 24 hours
  account.resetToken = {
    token: randomTokenString(),
    expires: new Date(Date.now() + 24 * 60 * 60 * 1000),
  };
  await account.save();

  // send email
  await sendPasswordResetEmail(account, origin);
}

async function validateResetToken({ token }) {
  const account = await db.Account.findOne({
    "resetToken.token": token,
    "resetToken.expires": { $gt: Date.now() },
  });

  if (!account) throw "Invalid token";
}

async function resetPassword({ token, password }) {
  const account = await db.Account.findOne({
    "resetToken.token": token,
    "resetToken.expires": { $gt: Date.now() },
  });

  if (!account) throw "Invalid token";
  // const data = await (await fetch(`http://localhost/user-change-password.php`, {
  //     method: 'POST',
  //     headers: { 'Content-Type': 'application/json' },
  //     body: {
  //         username: account.username,
  //         password: password
  //     }
  // })).json()
  const data = await axios.post("http://o2oviet.com/user-change-password.php", {
    username: account.username,
    password: password,
  });

  // update password and remove reset token
  account.passwordHash = hash(password);
  account.passwordReset = Date.now();
  account.resetToken = undefined;
  if (data.data.message == "Success") {
    const chatUser = await changeChatUserPassword({
      email: account.email,
      newPassword: password,
      access_token: account.chat_access_token,
    });
    await account.save();
  } else {
    throw "Đổi mật khẩu không thành công!";
  }
}

async function getAll() {
  const accounts = await db.Account.find();
  return accounts.map((x) => basicDetails(x));
}

async function getById(id) {
  const account = await getAccount(id);
  return basicDetails(account);
}

async function create(params) {
  // validate
  if (await db.Account.findOne({ email: params.email })) {
    throw 'Email "' + params.email + '" is already registered';
  }

  const account = new db.Account(params);
  account.verified = Date.now();

  // hash password
  account.passwordHash = hash(params.password);
  const { firstName, lastName, email, password, role, username } = params;
  if (role === Roles.User) {
    const chatUser = await synchronizedChatUser({
      username,
      firstName,
      lastName,
      email,
      password,
    }).catch((error) => {
      console.log("synchronize chat error when create", error);
    });
  }

  // save account
  await account.save();

  return basicDetails(account);
}

async function update(id, params) {
  const account = await getAccount(id);

  // validate (if email was changed)
  if (
    params.email &&
    account.email !== params.email &&
    (await db.Account.findOne({ email: params.email }))
  ) {
    throw 'Email "' + params.email + '" is already taken';
  }
  const chatUserUpdated = { ...params };
  if (params.email) {
    chatUserUpdated.newEmail = params.email;
  }

  // update chat user require email
  chatUserUpdated.email = account.email;

  // hash password if it was entered
  if (params.password) {
    params.passwordHash = hash(params.password);
    chatUserUpdated.newPassword = chatUserUpdated.password;
    delete chatUserUpdated.password;
    delete chatUserUpdated.confirmPassword;
  }

  // copy params to account and save
  Object.assign(account, params);
  account.updated = Date.now();

  const chatUser = await updateChatUser({
    ...chatUserUpdated,
    access_token: account.chat_access_token,
  });

  await account.save();

  return basicDetails(account);
}

async function _delete(id) {
  const account = await getAccount(id);
  await account.remove();
}

async function authorization(token) {
  try {
    const { email } = jwt.decode(token),
      account = await db.Account.findOne({ email });
    if (!account) throw "Authorization fail!";
    const verify = jwt.verify(token, config.secret);
    if (!verify) throw "Authorization fail!";

    const chatAuth = await authenticateChatAccessToken(
      account.chat_access_token
    ).catch((error) => {
      console.log("error when authenticate chat user", error);
    });

    return {
      email: account.email,
      username: account.username,
      chat_access_token: chatAuth.data ? chatAuth.data.token : "",
    };
  } catch (error) {
    throw error;
  }
}

// helper functions

async function getAccount(id) {
  if (!db.isValidId(id)) throw "Account not found";
  const account = await db.Account.findById(id);
  if (!account) throw "Account not found";
  return account;
}

async function getRefreshToken(token) {
  const refreshToken = await db.RefreshToken.findOne({ token }).populate(
    "account"
  );
  if (!refreshToken || !refreshToken.isActive) throw "Invalid token";
  return refreshToken;
}

function hash(password) {
  return bcrypt.hashSync(password, 10);
}

function generateJwtToken(account) {
  // create a jwt token containing the account id that expires in 15 minutes
  return jwt.sign(
    {
      sub: account.id,
      id: account.id,
      email: account.email,
      username: account.username,
    },
    config.secret,
    { expiresIn: "365d", algorithm: "HS256" }
  );
}

function generateRefreshToken(account, ipAddress) {
  // create a refresh token that expires in 7 days
  return new db.RefreshToken({
    account: account.id,
    token: randomTokenString(),
    expires: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    createdByIp: ipAddress,
  });
}

function randomTokenString() {
  return crypto.randomBytes(3).toString("hex").toUpperCase();
}

function basicDetails(account) {
  const {
    id,
    title,
    firstName,
    lastName,
    email,
    role,
    created,
    updated,
    isVerified,
    avatar,
    cover,
    background_image,
    address,
    working,
    working_link,
    about,
    school,
    gender,
    birthday,
    language,
    username,
    // chat_access_token,
  } = account;
  return {
    id,
    title,
    firstName,
    lastName,
    email,
    role,
    created,
    updated,
    isVerified,
    avatar,
    cover,
    background_image,
    address,
    working,
    working_link,
    about,
    school,
    gender,
    birthday,
    language,
    username,
    // chat_access_token,
  };
}

async function sendVerificationEmail(account, origin) {
  await sendEmail({
    to: account.email,
    subject: "Sign-up Verification API - Verify Email",
    html: `<h4>Verify Email</h4>
               <p>Thanks for registering!</p>
               <p>Your code for verify account ${account.email} is <code style="font-size: 18px;">${account.verificationToken}</code></p>`,
  });
}

async function sendAlreadyRegisteredEmail(email, origin) {
  let message;
  if (origin) {
    message = `<p>If you don't know your password please visit the <a href="${origin}/accounts/forgot-password">forgot password</a> page.</p>`;
  } else {
    message = `<p>If you don't know your password you can reset it via the <code>/accounts/forgot-password</code> api route.</p>`;
  }

  await sendEmail({
    to: email,
    subject: "Sign-up Verification API - Email Already Registered",
    html: `<h4>Email Already Registered</h4>
               <p>Your email <strong>${email}</strong> is already registered.</p>
               ${message}`,
  });
}

async function sendPasswordResetEmail(account, origin) {
  await sendEmail({
    to: account.email,
    subject: "Sign-up Verification API - Reset Password",
    html: `<h4>Reset Password Email</h4>
            <p>Your code for reset passwrod ${account.email} is <code style="font-size: 18px;">${account.resetToken.token}</code></p>`,
  });
}

async function submitDeviceToken(deviceToken, username) {
  const account = await db.Account.findOne({ username });
  if (!account) throw "Không tồn tại tài khoản này";
  account.deviceToken = deviceToken;
  const result = await chatHandler
    .updateDeviceToken({
      token: deviceToken,
      email: account.email,
    })
    .catch((error) => {
      console.log("error when update chat device token", error);
    });
  await account.save();
}

async function rawSubmitDeviceToken({ deviceId, token, user_id }) {
  const user = await db.Account.findOne({ _id: user_id });
  if (!user) {
    throw "Không tồn tại tài khoản này";
  }
  if (token) {
    if (
      !user.deviceTokens ||
      (user.deviceTokens instanceof Array && !user.deviceTokens.length)
    ) {
      user.deviceTokens = [{ deviceId, token }];
    }
    if (
      user.deviceTokens &&
      user.deviceTokens instanceof Array &&
      user.deviceTokens.length
    ) {
      const index = user.deviceTokens.findIndex(
        (item) => item.deviceId.toString() === deviceId
      );
      if (index === -1) {
        user.deviceTokens.push({ deviceId, token });
      } else {
        user.deviceTokens[index].token = token;
      }
    }
  }
  if (!token && user.deviceTokens && user.deviceTokens instanceof Array) {
    const index = user.deviceTokens.findIndex(
      (item) => item.deviceId.toString() === deviceId
    );
    if (index === -1) {
      return user;
    }
    user.deviceTokens.splice(index, 1);
  }
  if (user.deviceToken) {
    delete user.deviceToken;
  }
  await chatHandler
    .updateDeviceToken({ token, deviceId, email: user.email })
    .catch((error) => {
      console.log("error when update chat device token", error);
    });
  await user.save();
  return user;
}

async function testNotification(title, body, username) {
  const account = await db.Account.findOne({ username });
  const bodyFCM = {
    to: account.deviceToken,
    notification: {
      title: title,
      body: body,
      sound: "default",
      click_action: "FLUTTER_NOTIFICATION_CLICK",
      content_available: true,
      priority: "high",
      importance: "max",
      android_channel_id: "channel_android_default",
    },
    data: {
      url: "https://o2oviet.com/?postId=21",
    },
  };
  if (account.deviceToken) {
    firebaseCloudMessage(bodyFCM, (err, data) => {
      if (err) throw err;
      console.log(data);
    });
  } else {
    throw "Have no device token!";
  }
}

const firebaseCloudMessage = async (body, next) => {
  try {
    const res = await axios.post("https://fcm.googleapis.com/fcm/send", body, {
      headers: {
        Authorization: `key=AAAA1fHHF-I:APA91bGrV3SJFxHAV6FANwtFoZuXG0blmSk-Ym9L_mgcbQaoflV0O6FTzvWvln6JOnTw9k7BtBlsX1i_EcfUpyFQfloAzsDwe1hIHN-iFT9JsGDvl2_KNPuR_LrJ9ld4dZYR5SvF6qe_`,
      },
    });
    next(null, res);
  } catch (err) {
    next(err, null);
  }
};

async function authenticateChatUser({ email, password }) {
  try {
    const user = await db.Account.findOne({ email });
    if (!user) {
      throw { statusCode: 404, message: "user not found" };
    }
    const { username } = user;
    const result = await authenticate({
      username,
      password,
      isSynchroChatUser: false,
    });
    return result;
  } catch (error) {
    throw error;
  }
}
