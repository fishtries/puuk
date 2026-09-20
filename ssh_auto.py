import pty
import os
import sys

def main():
    if len(sys.argv) < 3:
        print("Usage: python3 ssh_auto.py <password> <command>")
        sys.exit(1)
        
    password = sys.argv[1]
    command = sys.argv[2]
    
    # Run SSH
    pid, fd = pty.fork()
    if pid == 0:
        # Child process: exec ssh
        os.execvp("ssh", ["ssh", "-o", "StrictHostKeyChecking=no", "-p", "59348", "fish@192.168.1.117", command])
    else:
        # Parent process: read and write to fd
        output = b""
        while True:
            try:
                data = os.read(fd, 1024)
                if not data:
                    break
                output += data
                
                # Check for password prompt
                if b"password" in data.lower():
                    os.write(fd, (password + "\n").encode())
            except OSError:
                break
                
        print(output.decode(errors='ignore'))
        os.waitpid(pid, 0)

if __name__ == '__main__':
    main()
