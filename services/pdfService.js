import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { UTApi } from "uploadthing/server";
import { File } from "node:buffer";

const utapi = new UTApi({ token: process.env.UPLOADTHING_SECRET });

// ========================== UPLOAD LOGIC ==========================

export async function uploadFileToUploadthing(filePath, shouldDelete = true) {
    try {
        if (!fs.existsSync(filePath)) return null;

        const fileBuffer = fs.readFileSync(filePath);
        const fileName = path.basename(filePath);

        const response = await utapi.uploadFiles([
            new File([fileBuffer], fileName, { type: "application/pdf" }),
        ]);

        const uploadResult = response[0];
        if (uploadResult.data) {
            if (shouldDelete) {
                try { fs.unlinkSync(filePath); } catch (e) { }
            }

            return {
                url: uploadResult.data.ufsUrl || uploadResult.data.url,
                key: uploadResult.data.key
            };
        }
        return null;
    } catch (error) {
        console.error("[Upload Error]:", error);
        return null;
    }
}

// ========================== VIEWING LOGIC ==========================

export async function streamPdfToResponse(filePathOrUrl, req, res) {
    try {
        if (filePathOrUrl.startsWith('http')) {
            console.log(`[PDF] Redirecting to Cloud URL: ${filePathOrUrl}`);
            return res.redirect(filePathOrUrl);
        } else {
            console.log(`[PDF] Serving Local PDF: ${filePathOrUrl}`);
            return res.download(filePathOrUrl);
        }
    } catch (err) {
        console.error("[PDF] Error:", err);
        res.status(500).send("Error retrieving PDF");
    }
}
