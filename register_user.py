import urllib.request
import json
import ssl
import sys


def register_user():
    print("--- Video Game Tracker Registration ---")
    username = input("Enter new username: ").strip()
    if not username:
        print("Username cannot be empty.")
        return

    password = input("Enter new password: ").strip()
    if not password:
        print("Password cannot be empty.")
        return

    url = "http://127.0.0.1:8000/users/"
    data = {"username": username, "password": password}

    json_data = json.dumps(data).encode("utf-8")
    headers = {"Content-Type": "application/json", "Accept": "application/json"}

    req = urllib.request.Request(url, data=json_data, headers=headers, method="POST")

    try:
        # Create unverified context just in case (though local http shouldn't need SSL)
        context = ssl._create_unverified_context()
        with urllib.request.urlopen(req, context=context) as response:
            if response.status == 200:
                print(f"\nSUCCESS: User '{username}' registered successfully!")
                response_body = response.read().decode("utf-8")
                print(f"Response: {response_body}")
            else:
                print(f"\nFAILED: Server returned status {response.status}")
                print(response.read().decode("utf-8"))

    except urllib.error.HTTPError as e:
        print(f"\nERROR: HTTP {e.code}")
        print(e.read().decode("utf-8"))
    except urllib.error.URLError as e:
        print(f"\nERROR: Connection failed. Is the backend running at {url}?")
        print(f"Details: {e.reason}")
    except Exception as e:
        print(f"\nAn unexpected error occurred: {e}")


if __name__ == "__main__":
    register_user()
