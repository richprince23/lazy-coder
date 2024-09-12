const vscode = require('vscode');
const axios = require('axios');

function activate(context) {
    let disposable = vscode.commands.registerCommand('lazy-coder.openPanel', async () => {
        const panel = vscode.window.createWebviewPanel(
            'lazy-coder',
            'Lazy Coder',
            vscode.ViewColumn.One,
            { enableScripts: true }
        );

        panel.webview.html = getWebviewContent();

        panel.webview.onDidReceiveMessage(async message => {
            if (message.command === 'sendPrompt') {
                try {
                    await vscode.window.withProgress({
                        location: vscode.ProgressLocation.Notification,
                        title: "Generating response...",
                        cancellable: false
                    }, async (progress) => {
                        const response = await sendToGeminiApi(message.prompt, message.imagePath);
                        insertResponseInEditor(response);
                        vscode.window.showInformationMessage('Response inserted in editor!');
                    });
                } catch (error) {
                    vscode.window.showErrorMessage(`Error: ${error.message}`);
                }
            }
        });
    });

    context.subscriptions.push(disposable);
}

function getWebviewContent() {
    return `
        <!DOCTYPE html>
        <html lang="en">
        <head>
            <meta charset="UTF-8">
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <title>Lazy Coder</title>
            <style>
                body { font-family: Arial, sans-serif; padding: 20px; }
                textarea { width: 100%; height: 100px; margin-bottom: 10px; }
                button { padding: 10px; }
            </style>
        </head>
        <body>
            <h2>Lazy Coder</h2>
            <input type="file" id="imageUpload" accept="image/*" /><br/><br/>
            <textarea id="prompt" placeholder="Enter your prompt"></textarea><br/>
            <button onclick="send()">Send</button>

            <script>
                const vscode = acquireVsCodeApi();

                function send() {
                    const prompt = document.getElementById('prompt').value;
                    const imageUpload = document.getElementById('imageUpload').files[0];

                    if (imageUpload) {
                        const reader = new FileReader();
                        reader.onloadend = function () {
                            vscode.postMessage({
                                command: 'sendPrompt',
                                prompt: prompt,
                                imagePath: reader.result
                            });
                        };
                        reader.readAsDataURL(imageUpload);
                    } else {
                        vscode.postMessage({
                            command: 'sendPrompt',
                            prompt: prompt,
                            imagePath: null
                        });
                    }
                }
            </script>
        </body>
        </html>
    `;
}

async function sendToGeminiApi(prompt, imageBase64) {
    const apiKey = await getApiKey();
    const apiUrl = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro-vision:generateContent';

    const requestBody = {
        contents: [
            {
                parts: [
                    { text: prompt }
                ]
            }
        ],
        generationConfig: {
            temperature: 0.4,
            topK: 32,
            topP: 1,
            maxOutputTokens: 4096,
        }
    };

    if (imageBase64) {
        requestBody.contents[0].parts.push({
            inlineData: {
                mimeType: 'image/jpeg',
                data: imageBase64.split(',')[1]
            }
        });
    }

    try {
        const response = await axios.post(apiUrl, requestBody, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            }
        });

        return response.data.candidates[0].content.parts[0].text;
    } catch (error) {
        console.error('Error calling Gemini API:', error.response?.data || error.message);
        throw new Error('Failed to get response from Gemini API');
    }
}

function insertResponseInEditor(response) {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
        editor.edit(editBuilder => {
            editBuilder.insert(editor.selection.active, response);
        });
    } else {
        vscode.window.showWarningMessage('No active text editor found');
    }
}

async function getApiKey() {
    const config = vscode.workspace.getConfiguration('lazyCoder');
    let apiKey = config.get('apiKey');
    
    if (!apiKey) {
        apiKey = await vscode.window.showInputBox({
            prompt: 'Enter your Gemini API Key',
            password: true
        });
        
        if (apiKey) {
            await config.update('apiKey', apiKey, vscode.ConfigurationTarget.Global);
        } else {
            throw new Error('API Key is required');
        }
    }
    
    return apiKey;
}
function deactivate() {}

module.exports = {
    activate,
    deactivate
};