import os
import json
import hashlib
import boto3
from flask import Flask, request, send_file
from pathlib import Path
from tempfile import NamedTemporaryFile

app = Flask(__name__, static_folder='.', static_url_path='')

# Get credentials from environment
aws_access_key = os.environ.get('AWS_ACCESS_KEY_ID')
aws_secret_key = os.environ.get('AWS_SECRET_ACCESS_KEY')
aws_region = os.environ.get('AWS_REGION', 'us-east-1')
polly_voice_id = os.environ.get('POLLY_VOICE_ID', 'Joanna')
polly_engine = os.environ.get('POLLY_ENGINE', 'standard')
polly_cache_dir = Path(os.environ.get('POLLY_CACHE_DIR', '/tmp/reader-polly-cache'))
polly_cache_dir.mkdir(parents=True, exist_ok=True)

def polly_cache_path(text):
    cache_payload = json.dumps({
        'engine': polly_engine,
        'format': 'mp3',
        'text': text,
        'voice': polly_voice_id
    }, sort_keys=True, separators=(',', ':'))
    cache_key = hashlib.sha256(cache_payload.encode('utf-8')).hexdigest()
    return polly_cache_dir / f'{cache_key}.mp3'

# Initialize AWS Polly client
if aws_access_key and aws_secret_key:
    polly = boto3.client(
        'polly',
        region_name=aws_region,
        aws_access_key_id=aws_access_key,
        aws_secret_access_key=aws_secret_key
    )
else:
    polly = None
    print(f"WARNING: AWS credentials not found. Expected AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY environment variables.")

@app.route('/api/speak', methods=['POST'])
def speak():
    try:
        if not polly:
            return {'error': 'AWS credentials not configured'}, 503

        data = request.json
        text = data.get('text', '').strip()

        if not text:
            return {'error': 'No text provided'}, 400

        cache_path = polly_cache_path(text)
        if cache_path.exists():
            return send_file(
                cache_path,
                mimetype='audio/mpeg',
                as_attachment=False,
                max_age=31536000
            )

        # Call AWS Polly
        response = polly.synthesize_speech(
            Text=text,
            Engine=polly_engine,
            OutputFormat='mp3',
            VoiceId=polly_voice_id
        )

        # Get the audio stream
        audio = response['AudioStream'].read()
        with NamedTemporaryFile(dir=polly_cache_dir, delete=False) as temp_file:
            temp_file.write(audio)
            temp_path = Path(temp_file.name)
        temp_path.replace(cache_path)

        # Return as MP3
        return send_file(
            cache_path,
            mimetype='audio/mpeg',
            as_attachment=False,
            max_age=31536000
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
