const nodemailer = require('nodemailer');
const config = require('config.json');

module.exports = sendEmail;

async function sendEmail({ to, subject, html, from = config.emailFrom }) {
    try {
        const transporter = nodemailer.createTransport(config.smtpOptions);
        await transporter.sendMail({ from, to, subject, html });
        console.log("Send email success!")
    } catch (err) {
        console.log("Error")
	console.log(err)
    }
}
