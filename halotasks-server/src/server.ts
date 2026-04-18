import dotenv from 'dotenv';
import app from './app';
import { connectDB } from './config/db';

dotenv.config();

const port = Number(process.env.PORT ?? 5000);

const startServer = async () => {
	await connectDB();

	app.listen(port, () => {
		console.log(`Server running on port ${port}`);
	});
};

void startServer();
