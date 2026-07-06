import os
import json
import boto3
from flask import Flask, request, send_file
from io import BytesIO

app = Flask(__name__, static_folder='.', static_url_path='')

# Initialize AWS Polly client
polly = boto3.client(
    'polly',
    region_name=os.environ.get('AWS_REGION', 'us-east-1'),
    aws_access_key_id=os.environ.get('AWS_ACCESS_KEY_ID'),
    aws_secret_access_key=os.environ.get('AWS_SECRET_ACCESS_KEY')
)

@app.route('/api/speak', methods=['POST'])
def speak():
    try:
        data = request.json
        text = data.get('text', '').strip()

        if not text:
            return {'error': 'No text provided'}, 400

        # Call AWS Polly
        response = polly.synthesize_speech(
            Text=text,
            OutputFormat='mp3',
            VoiceId='Joanna'  # You can make this configurable
        )

        # Get the audio stream
        audio = response['AudioStream'].read()

        # Return as MP3
        return send_file(
            BytesIO(audio),
            mimetype='audio/mpeg',
            as_attachment=False
        )

    except Exception as e:
        print(f"Polly error: {e}")
        return {'error': str(e)}, 500

@app.route('/')
@app.route('/<path:path>')
def serve(path='index.html'):
    if path and os.path.isfile(path):
        return app.send_static_file(path)
    return app.send_static_file('index.html')

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 4177))
    app.run(host='0.0.0.0', port=port, debug=False)
